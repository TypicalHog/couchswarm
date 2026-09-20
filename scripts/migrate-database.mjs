import { createClient } from '@libsql/client';
import nextEnv from '@next/env';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
// next dev and next build read TURSO_* from .env files as well, so the runner loads the same chain:
// a URL set in .env.local otherwise migrates the local fallback while the app answers 503 from it.
// Shell and Vercel variables still win, and only predev loads the development files, as next dev does.
nextEnv.loadEnvConfig(process.cwd(), process.env.npm_lifecycle_event === 'predev');
const url = process.env.TURSO_DATABASE_URL || (process.env.VERCEL || process.env.NODE_ENV === 'production' ? '' : 'file:.local/rooms.db');
if (!url) throw new Error('Set TURSO_DATABASE_URL to the target database.');
if (url.startsWith('file:')) await mkdir(path.dirname(url.slice(5).replace(/^\/+(?=[A-Za-z]:)/, '')), { recursive: true });
// Without a busy timeout a runner that meets another's lock fails instantly, before the bookkeeping
// row's PRIMARY KEY below can turn the race into a skip: a build next to a dev server's predev aborts.
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN, timeout: 5000 });
// Database variables left unscoped make a preview build migrate production, so every build log says which
// database this run is about to change, and from which deployment.
console.log(`Migrating ${url.startsWith('file:') ? url : new URL(url).host}`
  + (process.env.VERCEL_ENV ? ` (${[process.env.VERCEL_ENV, process.env.VERCEL_GIT_COMMIT_REF].filter(Boolean).join(', ')})` : ''));
try {
  await client.execute('CREATE TABLE IF NOT EXISTS couchswarm_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
  for (const name of (await readdir('drizzle')).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = (await readFile(`drizzle/${name}`, 'utf8')).replace(/\r\n?/g, '\n');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.execute({ sql: 'SELECT checksum FROM couchswarm_migrations WHERE name = ?', args: [name] });
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum)
        throw new Error(
          `Applied migration changed: ${name}. Add a new drizzle/NNNN_*.sql instead of editing an applied one; revert the edit to restore the build. To adopt an edit you have verified changes no DDL: UPDATE couchswarm_migrations SET checksum = '${checksum}' WHERE name = '${name}';`,
        );
      continue;
    }
    const statements = sql
      .split('--> statement-breakpoint')
      .map((sql) => sql.trim())
      .filter(Boolean);
    // libSQL prepares only the first statement of a chunk and discards the rest without erroring.
    // Blanking string literals first keeps a quoted ';' from tripping the guard, and a quoted '--' from
    // hiding the statement behind it from both the guard and libSQL.
    for (const statement of statements)
      if (/;\s*\S/.test(statement.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '')))
        throw new Error(`${name}: separate statements with --> statement-breakpoint, not ';'`);
    try {
      // migrate() turns foreign keys off before BEGIN, which batch() cannot do, and the bookkeeping
      // row goes first so its PRIMARY KEY serialises two builds racing on the same database.
      await client.migrate([
        { sql: 'INSERT INTO couchswarm_migrations (name, checksum) VALUES (?, ?)', args: [name, checksum] },
        ...statements,
      ]);
    } catch (error) {
      if (error.statementIndex !== 0 || !String(error.code).startsWith('SQLITE_CONSTRAINT')) throw error;
      console.log(`Skipped ${name} (applied concurrently)`);
      continue;
    }
    console.log(`Applied ${name}`);
  }
} finally {
  client.close();
}
