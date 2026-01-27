import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5,
});


