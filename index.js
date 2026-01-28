import "dotenv/config";

import express from "express";
import cors from "cors";

// load DB after env
const { pool } = await import("./db.js");

const app = express();
app.use(cors());
app.use(express.json());

/** --- Auth helpers --- */
function expectedSyncKey() {
  return String(process.env.SYNC_KEY || "").trim();
}

function incomingSyncKey(req) {
  // Express lowercases headers, but this is safe
  return String(req.headers["x-sync-key"] || "").trim();
}

function requireSyncKey(req, res) {
  const expected = expectedSyncKey();
  const incoming = incomingSyncKey(req);

  if (!expected) {
    res.status(500).json({ error: "Server missing SYNC_KEY" });
    return false;
  }
  if (incoming !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/** --- Lightweight health/debug endpoints (safe to keep) --- */
app.get("/", (req, res) => res.send("Menu API is running 🌮"));
app.get("/ping", (req, res) => res.status(200).send("pong"));

app.get("/db-health", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (err) {
    console.error("❌ DB health failed:", err);
    res.status(500).json({ ok: false, error: "db_unreachable" });
  }
});

/** --- Sync endpoint (Google Sheets → API) --- */
app.post("/sync", (req, res) => {
  if (!requireSyncKey(req, res)) return;

  const { business_id, sheet, values, timestamp } = req.body;

  if (!business_id || !sheet || !Array.isArray(values)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Respond immediately so Apps Script never hangs
  res.status(200).json({ status: "accepted" });

  // Fire-and-forget async work
  (async () => {
    try {
      if (sheet === "menu") await syncMenu(business_id, values);
      else if (sheet === "hours") await syncHours(business_id, values);
      else if (sheet === "location") await syncLocation(business_id, values);
      else {
        console.log("❌ Unknown sheet:", sheet);
        return;
      }

      await pool.query(
        `INSERT INTO sync_status (business_id, last_synced_at, last_sheet)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (business_id)
         DO UPDATE SET last_synced_at = NOW(), last_sheet = EXCLUDED.last_sheet`,
        [business_id, sheet]
      );

      console.log(`✅ Sync complete: ${sheet} for ${business_id} @ ${timestamp}`);
    } catch (err) {
      console.error("❌ Sync failed:", err);
    }
  })();
});

/** --- DB writers --- */
async function syncMenu(businessId, values) {
  const rows = values.slice(1); // skip header
  await pool.query("DELETE FROM menu_items WHERE business_id = $1", [businessId]);

  for (const r of rows) {
    if (!r || r.length < 5) continue;

    const [id, name, price, description, active] = r;
    if (id === "" || name === "" || price === "") continue;

    await pool.query(
      `INSERT INTO menu_items (business_id, id, name, price, description, active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        businessId,
        Number(id),
        String(name),
        Number(price),
        description ? String(description) : null,
        active === true || String(active).toUpperCase() === "TRUE",
      ]
    );
  }
}

async function syncHours(businessId, values) {
  const rows = values.slice(1); // skip header

  await pool.query("DELETE FROM hours WHERE business_id = $1", [businessId]);

  for (const r of rows) {
    if (!r || r.length < 3) continue;

    const [day, open, close] = r;
    if (!day) continue;

    await pool.query(
      `INSERT INTO hours (business_id, day, open, close)
       VALUES ($1, $2, $3, $4)`,
      [businessId, String(day).trim(), normalizeSheetTime(open), normalizeSheetTime(close)]
    );
  }
}

/**
 * Converts Sheets time values into "HH:MM" (or null).
 * Handles:
 * - "1899-12-30T05:00:00.000Z" (your current case)
 * - real Date objects
 * - "11:00" / "11:00:00"
 */
function normalizeSheetTime(v) {
  if (v == null || v === "") return null;

  // If it's already a Date object
  if (Object.prototype.toString.call(v) === "[object Date]") {
    const hh = String(v.getHours()).padStart(2, "0");
    const mm = String(v.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // If it's the ISO string like "1899-12-30T05:00:00.000Z"
  const s = String(v).trim();
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    // Use UTC because your string ends with Z
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // If it's "11:00" or "11:00:00"
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s.slice(0, 5);

  // fallback
  return null;
}


async function syncLocation(businessId, values) {
  // values[0] = headers row, values[1] = first data row
  const headers = values[0] || [];
  const row = values[1] || [];

  const map = {};
  for (let i = 0; i < headers.length; i++) {
    const key = String(headers[i] || "").trim().toLowerCase();
    map[key] = String(row[i] || "").trim();
  }

  const current_spot = map["current_spot"] || null;
  const note = map["note"] || null;

  await pool.query(
    `INSERT INTO location (business_id, current_spot, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id)
     DO UPDATE SET current_spot = EXCLUDED.current_spot, note = EXCLUDED.note`,
    [businessId, current_spot, note]
  );
}


/** --- Read endpoints (Next.js uses these) --- */
app.get("/business/:id/menu", async (req, res) => {
  try {
    const businessId = req.params.id;
    const result = await pool.query(
      `SELECT id, name, price, description, active
       FROM menu_items
       WHERE business_id = $1
       ORDER BY id ASC`,
      [businessId]
    );
    res.json({ business_id: businessId, menu: result.rows });
  } catch (err) {
    console.error("❌ GET menu failed:", err);
    res.status(500).json({ error: "Failed to load menu" });
  }
});

app.get("/business/:id/hours", async (req, res) => {
  try {
    const businessId = req.params.id;
    const result = await pool.query(
      `SELECT day, open, close
       FROM hours
       WHERE business_id = $1`,
      [businessId]
    );
    res.json({ business_id: businessId, hours: result.rows });
  } catch (err) {
    console.error("❌ GET hours failed:", err);
    res.status(500).json({ error: "Failed to load hours" });
  }
});

app.get("/business/:id/location", async (req, res) => {
  try {
    const businessId = req.params.id;
    const result = await pool.query(
      `SELECT current_spot, note
       FROM location
       WHERE business_id = $1`,
      [businessId]
    );
    res.json({
      business_id: businessId,
      location: result.rows[0] || { current_spot: null, note: null },
    });
  } catch (err) {
    console.error("❌ GET location failed:", err);
    res.status(500).json({ error: "Failed to load location" });
  }
});

app.get("/business/:id/status", async (req, res) => {
  try {
    const businessId = req.params.id;
    const result = await pool.query(
      `SELECT last_synced_at, last_sheet
       FROM sync_status
       WHERE business_id = $1`,
      [businessId]
    );
    res.json({ business_id: businessId, status: result.rows[0] || null });
  } catch (err) {
    console.error("❌ GET status failed:", err);
    res.status(500).json({ error: "Failed to load status" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
