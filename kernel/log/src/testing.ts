import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Sql } from "./db.js";
import { kernelMigrationsDir, migrate } from "./migrate.js";

/** Creates a fresh migrated database for a test file; drop() removes it. */
export async function createTestDb(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const adminUrl = process.env["TEST_ADMIN_DATABASE_URL"];
  if (adminUrl === undefined || adminUrl === "") {
    throw new Error("TEST_ADMIN_DATABASE_URL is not set (see .env.example)");
  }
  const admin = postgres(adminUrl);
  const name = `nc_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString());
  await migrate(sql, kernelMigrationsDir);
  return {
    sql,
    drop: async (): Promise<void> => {
      await sql.end();
      await admin.unsafe(`drop database ${name}`);
      await admin.end();
    },
  };
}
