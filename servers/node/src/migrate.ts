import dotenv from "dotenv";
import pg from "pg";

import { ensureProtocolSchema } from "./protocol.js";

dotenv.config({ path: "../../.env" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const version = await ensureProtocolSchema(pool);
  console.log(`opto-sync protocol schema is at version ${version}`);
} finally {
  await pool.end();
}
