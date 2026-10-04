import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    });
    db = drizzle(pool, { schema });
    console.log("[db] PostgreSQL pool created successfully");
  } catch (err) {
    console.warn("[db] Failed to create PostgreSQL pool:", err);
    pool = null;
    db = null;
  }
} else {
  console.warn("[db] DATABASE_URL not set, database features will use file storage fallback");
}

export { pool, db };
