import { Client } from "pg";
import { applyMigrations } from "@eim/db";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to apply migrations.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await applyMigrations(client);
    console.log(`Applied migrations: ${result.applied.length}`);
    console.log(`Skipped migrations: ${result.skipped.length}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exitCode = 1;
});
