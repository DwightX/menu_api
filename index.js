// Load env FIRST (preload style)
import "dotenv/config";

import express from "express";
import cors from "cors";

// ✅ IMPORTANT: dynamic import AFTER dotenv is loaded
const { pool } = await import("./db.js");

pool.query("select now()")
  .then(res => console.log("DB connected at:", res.rows[0].now))
  .catch(err => console.error("DB connection failed:", err));

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("Taco Sync API is running 🌮");
});

// Sync endpoint (Google Sheets hits this)
app.post("/sync", async (req, res) => {

      const incomingKey = req.headers["x-sync-key"];

  console.log("🔥 HIT /sync");
  console.log("incoming x-sync-key:", incomingKey);
  console.log("env SYNC_KEY set:", !!process.env.SYNC_KEY);
  
  if (incomingKey !== process.env.SYNC_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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

    // ✅ NEW: update "last updated" status after successful sync
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
        active === true || String(active).toUpperCase() === "TRUE"
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
      [businessId, String(day), open || null, close || null]
    );
  }
}

async function syncLocation(businessId, values) {
  const rows = values.slice(1); // skip header

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

const PORT = process.env.PORT || 3000;

// Read: Menu
app.get("/business/:id/menu", async (req, res) => {
  const businessId = req.params.id;

  try {
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

// Read: Hours
app.get("/business/:id/hours", async (req, res) => {
  const businessId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT day, open, close
       FROM hours
       WHERE business_id = $1
       ORDER BY
         CASE day
           WHEN 'Monday' THEN 1
           WHEN 'Tuesday' THEN 2
           WHEN 'Wednesday' THEN 3
           WHEN 'Thursday' THEN 4
           WHEN 'Friday' THEN 5
           WHEN 'Saturday' THEN 6
           WHEN 'Sunday' THEN 7
           ELSE 8
         END`,
      [businessId]
    );

    res.json({ business_id: businessId, hours: result.rows });
  } catch (err) {
    console.error("❌ GET hours failed:", err);
    res.status(500).json({ error: "Failed to load hours" });
  }
});

// Read: Location
app.get("/business/:id/location", async (req, res) => {
  const businessId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT current_spot, note
       FROM location
       WHERE business_id = $1`,
      [businessId]
    );

    res.json({
      business_id: businessId,
      location: result.rows[0] || { current_spot: null, note: null }
    });
  } catch (err) {
    console.error("❌ GET location failed:", err);
    res.status(500).json({ error: "Failed to load location" });
  }
});

// ✅ NEW: Read "Last updated" status
app.get("/business/:id/status", async (req, res) => {
  const businessId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT last_synced_at, last_sheet
       FROM sync_status
       WHERE business_id = $1`,
      [businessId]
    );

    res.json({
      business_id: businessId,
      status: result.rows[0] || null
    });
  } catch (err) {
    console.error("❌ GET status failed:", err);
    res.status(500).json({ error: "Failed to load status" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
