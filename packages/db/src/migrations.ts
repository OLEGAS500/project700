import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

const migrationLockKey = 424_007_001;

type MigrationRow = {
  name: string;
  checksum: string;
};

export type AppliedMigrationsResult = {
  applied: string[];
  skipped: string[];
};

export async function applyMigrations(
  client: Pick<pg.Client | pg.PoolClient, "query">,
  migrationsDirectory = path.join(process.cwd(), "packages/db/migrations")
): Promise<AppliedMigrationsResult> {
  await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);

  try {
    await client.query(
      `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        )
      `
    );

    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const name of migrationNames) {
      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<MigrationRow>(
        "SELECT name, checksum FROM schema_migrations WHERE name = $1",
        [name]
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${name}`);
        }
        skipped.push(name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      applied.push(name);
    }

    return { applied, skipped };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
  }
}
