import { createClient, type Client, type InValue, type ResultSet } from '@libsql/client';
import type { Db } from '@/lib/db';
let client: Client | undefined;
function connection() {
  if (client) return client;
  // Local development needs no environment; predev migrates the same file.
  const url = process.env.TURSO_DATABASE_URL || (process.env.VERCEL ? '' : 'file:.local/rooms.db');
  if (!url) throw new Error('Set TURSO_DATABASE_URL and run npm run db:migrate before starting CouchSwarm.');
  if (process.env.VERCEL && url.startsWith('file:')) throw new Error('Vercel requires a remote Turso database.');
  return client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}
function result(value: ResultSet) { return { results: value.rows, success: true, meta: { changes: value.rowsAffected } }; }
class Statement {
  constructor(readonly sql: string, readonly args: InValue[] = []) {}
  bind(...args: InValue[]) { return new Statement(this.sql, args); }
  async first<T>() { return (await connection().execute(this)).rows[0] as T | undefined ?? null; }
  async all<T>() { return { results: (await connection().execute(this)).rows as T[] }; }
  async run() { return result(await connection().execute(this)); }
}
export function getDatabase(): Db {
  return { prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => (await connection().batch(statements, 'write')).map(result) };
}
