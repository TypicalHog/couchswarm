import { createClient, type Client, type InValue, type ResultSet } from '@libsql/client';
import type { Db } from '@/lib/db';
let client: Client | undefined;
function connection() {
  if (client) return client;
  // Local development needs no environment; predev migrates the same file.
  const url = process.env.TURSO_DATABASE_URL || (process.env.VERCEL || process.env.NODE_ENV === 'production' ? '' : 'file:.local/rooms.db');
  if (!url) throw new Error('Set TURSO_DATABASE_URL and run npm run db:migrate before starting CouchSwarm.');
  if (process.env.VERCEL && url.startsWith('file:')) throw new Error('Vercel requires a remote Turso database.');
  // Without a busy timeout a second writer on the same .local file fails instantly with SQLITE_BUSY.
  // A remote client ignores that timeout, so every HTTP statement carries its own deadline: a Turso that
  // accepts the connection and then goes quiet has to throw, or withDb never gets to answer its 503.
  return client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN, timeout: 2000,
    fetch: (request: Request) => fetch(request, { signal: AbortSignal.timeout(3000) }) });
}
function result(value: ResultSet) { return { results: value.rows, success: true, meta: { changes: value.rowsAffected } }; }
class Statement {
  // Parameter properties cannot be erased, and the tests run this file through Node's type stripping.
  readonly sql: string; readonly args: InValue[];
  constructor(sql: string, args: InValue[] = []) { this.sql = sql; this.args = args; }
  bind(...args: InValue[]) { return new Statement(this.sql, args); }
  async first<T>() { return (await connection().execute(this)).rows[0] as T | undefined ?? null; }
  async all<T>() { return { results: (await connection().execute(this)).rows as T[] }; }
  async run() { return result(await connection().execute(this)); }
}
export function getDatabase(): Db {
  return { prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => (await connection().batch(statements, 'write')).map(result) };
}
