import "dotenv/config";

import express from "express";
import cors from "cors";

// dynamic import so env is loaded first
const { pool } = await import("./db.js");

const app = express();
app.use(cors());
app.use(express.json());

// --- Helpers ---
function getExpectedKey() {
  // trim to avoid invisible whitespace issues in Render env vars
  return (process.env.SYNC_KEY || "").trim();
}

function getIncomingKey(req) {
  // handle possible header variants safely + trim
  const raw =
    req.headers["x-sync-key"] ||
    req.headers["X-Sync-Key"] ||
    req.get?.("x-sync-key") ||
    "";
  return String(raw).trim();
}

function requireSyncKey(req, res) {
  const expected = getExpectedKey();
  const incoming = getIncomingKey(req);

  if (!expected) {
    // server misconfigured
    res.status(500).json({ error: "Server missing SYNC_KEY env var" });
    return false;
  }

  if (incoming !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}


function testRenderSync() {
  const url = "https://menu-api-u20i.onrender.com/sync";

  const payload = {
    business_id: "taco-truck-001",
    sheet: "menu",
    values: [["id","name","price","description","active"],[1,"Manual Test",9.99,"",true]],
    timestamp: new Date().toISOString()
  };

  Logger.log("START testRenderSync at " + new Date().toISOString());

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { "x-sync-key": "TACO_SECRET" },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: true,
      timeout: 30, // ✅ seconds
    });

    Logger.log("DONE fetch at " + new Date().toISOString());
    Logger.log("CODE: " + resp.getResponseCode());
    Logger.log("BODY: " + resp.getContentText());
  } catch (err) {
    Logger.log("FETCH ERROR at " + new Date().toISOString());
    Logger.log("ERROR: " + err);
    throw err;
  }
}


// Health
app.get("/", (req, res) => {
  res.send("Menu API is running 🌮");
});

/**
 * ✅ One-shot confirmation endpoint
 * - Doesn’t reveal the secret
 * - Confirms env var exists + lengths match after trimming
 * - Confirms header you sent is recognized
 *
 * Remove after you’re done verifying.
 */
app.get("/debug/auth", (req, res) => {
  const expected = getExpectedKey();
  const incoming = getIncomingKey(req);

  res.json({
    ok: incoming === expected,
    expected_set: !!expected,
    expected_len: expected.length,
    incoming_present: !!incoming,
    incoming_len: incoming.length,
  });
});

// --- Sync endpoint ---
app.post("/sync", async (req, res) => {
  if (!requireSyncKey(req, res)) return;

  const { business_id, sheet, values, timestamp } = req.body;

  if (!business_id || !sheet || !Array.isArray(values)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    if (sheet === "menu") {
      await syncMenu(business_id, values);
    } else if (sheet === "hours") {
      await syncHours(business_id, values);
    } else if (sheet === "location") {
      await syncLocation(business_id, values);
    } else {
      return res.status(400).json({ error: "Unknown sheet" });
    }

    // last updated stamp
    await pool.query(
      `INSERT INTO sync_status (business_id, last_synced_at, last_sheet)
       VALUES ($1, NOW(), $2)
       ON CONFLICT (business_id)
       DO UPDATE SET last_synced_at = NOW(), last_sheet = EXCLUDED.last_sheet`,
      [business_id, sheet]
    );

    console.log(`✅ Synced ${sheet} for ${business_id} @ ${timestamp}`);
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("❌ Sync failed:", err);
    return res.status(500).json({ error: "Sync failed" });
  }
});

// --- DB writers ---
async function syncMenu(businessId, values) {
  const rows = values.slice(1);
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
  const rows = values.slice(1);
  await pool.query("DELETE FROM hours WHERE business_id = $1", [businessId]);

  for (const r of rows) {
    if (!r || r.length < 3) continue;

    const [day, open, close] = r;
    if (!day) continue;

    await pool.query(
      `INSERT INTO hours (business_id, day, open, close)
       VALUES ($1, $2, $3, $4)`,
      [businessId, String(day), open || null, close || null]
    );
  }
}

async function syncLocation(businessId, values) {
  const rows = values.slice(1);

  let current_spot = null;
  let note = null;

  for (const r of rows) {
    const label = String(r[0] || "").trim();
    const value = String(r[1] || "").trim();
    if (label === "current_spot") current_spot = value;
    if (label === "note") note = value;
  }

  await pool.query(
    `INSERT INTO location (business_id, current_spot, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id)
     DO UPDATE SET current_spot = EXCLUDED.current_spot, note = EXCLUDED.note`,
    [businessId, current_spot, note]
  );
}

// --- Read endpoints ---
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
    res.json({ business_id: businessId, location: result.rows[0] || { current_spot: null, note: null } });
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
 