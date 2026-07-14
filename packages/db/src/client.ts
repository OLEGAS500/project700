import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to use the database");
  }

  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL
  });

  return pool;
}

export async function closePool(): Promise<void> {
  const activePool = pool;
  pool = undefined;
  await activePool?.end();
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
