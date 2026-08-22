import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./db.js";

export const kernelMigrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/** Applies unapplied .sql files from the directory in lexical order. */
export async function migrate(sql: Sql, migrationsDir: string): Promise<string[]> {
  await sql`
    create table if not exists migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const seen = await sql`select 1 from migrations where name = ${file}`;
    if (seen.length > 0) {
      continue;
    }
    const text = await readFile(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into migrations (name) values (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
