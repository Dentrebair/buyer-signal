import pg from "pg";

// Session pooler allows 60 connections in total (§12 item 7): keep each service's pool small.
export function createPool(max: number, connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  // An idle client dropped by the pooler emits 'error' on the pool; unhandled, it would crash the
  // process. The pool discards that client and opens a new one on the next query.
  pool.on("error", (e) => console.error(JSON.stringify({ t: new Date().toISOString(), msg: "pg pool: idle client error", error: e.message })));
  return pool;
}

export type Db = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
