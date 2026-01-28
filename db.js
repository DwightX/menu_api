import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Required for Neon / Render
  ssl: { rejectUnauthorized: true },

  // Stability + protection
  max: 5,                     // small pool = safe for Neon
  idleTimeoutMillis: 30_000,  // close idle connections
  connectionTimeoutMillis: 10_000,
});
