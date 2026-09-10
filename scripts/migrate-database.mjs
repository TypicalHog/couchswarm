import { createClient } from '@libsql/client';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const url = process.env.TURSO_DATABASE_URL || (process.env.VERCEL ? '' : 'file:.local/rooms.db');
if (!url) throw new Error('Set TURSO_DATABASE_URL to the target database.');
if (url.startsWith('file:')) await mkdir(path.dirname(url.slice(5).replace(/^\/+(?=[A-Za-z]:)/, '')), { recursive: true });
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  await client.execute('CREATE TABLE IF NOT EXISTS couchswarm_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
  for (const name of (await readdir('drizzle')).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = (await readFile(`drizzle/${name}`, 'utf8')).replace(/\r\n?/g, '\n');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.execute({ sql: 'SELECT checksum FROM couchswarm_migrations WHERE name = ?', args: [name] });
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.batch(
      [
        ...sql
          .split('--> statement-breakpoint')
          .map((sql) => sql.trim())
          .filter(Boolean),
        { sql: 'INSERT INTO couchswarm_migrations (name, checksum) VALUES (?, ?)', args: [name, checksum] },
      ],
      'write',
    );
    console.log(`Applied ${name}`);
  }
} finally {
  client.close();
}
