import postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    // "already exists, skipping" / "does not exist, skipping" notices are the
    // expected chatter of idempotent DDL (if-not-exists, drop-if-exists).
    // Anything else is surfaced.
    onnotice: (notice) => {
      if (notice["code"] !== "42P07" && !/skipping/.test(notice["message"] ?? "")) {
        console.error(`postgres ${notice["severity"]}: ${notice["message"]}`);
      }
    },
  });
}

/** A jsonb query parameter. The cast is the one place `unknown` meets postgres.js. */
export function jsonb(sql: Sql | TransactionSql, value: unknown): postgres.Parameter {
  return sql.json(value as postgres.JSONValue);
}
