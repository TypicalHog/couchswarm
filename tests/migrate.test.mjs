import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const runner = fileURLToPath(new URL('../scripts/migrate-database.mjs', import.meta.url));

// Every case runs the real runner against a throwaway project, because predev, build and db:migrate are
// the only things that run it: a guard that stops working is otherwise found by a Vercel build.
async function project(t, files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'couchswarm-migrate-test-'));
  t.after(async () => { if (path.dirname(dir) === tmpdir()) await rm(dir, { recursive: true, force: true }); });
  await mkdir(path.join(dir, 'drizzle'));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, 'drizzle', name), sql);
  return dir;
}
function migrate(dir, overrides = {}) {
  const env = { ...process.env, TURSO_DATABASE_URL: 'file:rooms.db', VERCEL: '', ...overrides };
  // A set but empty variable counts as a real value and would shut out the .env file, so a case that
  // wants one unset has to unset it rather than blank it.
  for (const name of ['TURSO_DATABASE_URL', 'VERCEL']) if (!env[name]) delete env[name];
  return run(process.execPath, [runner], { cwd: dir, env });
}

test('applies a migration once and refuses an edit to an applied one', async (t) => {
  const dir = await project(t, { '0000_rooms.sql': 'CREATE TABLE rooms (id TEXT PRIMARY KEY)' });
  assert.match((await migrate(dir)).stdout, /Applied 0000_rooms\.sql/);
  assert.doesNotMatch((await migrate(dir)).stdout, /Applied/);
  const file = path.join(dir, 'drizzle', '0000_rooms.sql');
  await writeFile(file, 'CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT)');
  await assert.rejects(migrate(dir), /Applied migration changed/);
  // A byte order mark is the same editor churn as a CRLF re-save, and changes no DDL.
  await writeFile(file, '﻿CREATE TABLE rooms (id TEXT PRIMARY KEY)');
  assert.doesNotMatch((await migrate(dir)).stdout, /Applied/);
});

test('reads a ; as a statement separator outside string literals only', async (t) => {
  const two = await project(t, { '0000_two.sql': 'CREATE TABLE a (x INT); CREATE TABLE b (y INT)' });
  await assert.rejects(migrate(two), /statement-breakpoint/);
  // libSQL would prepare the first statement and drop the second without erroring, and the run would
  // still record the file as applied, so a quoted '--' must not hide what comes after it.
  const dash = await project(t, { '0000_dash.sql': "CREATE TABLE a (dash TEXT DEFAULT '--');\nCREATE TABLE b (y INT)" });
  await assert.rejects(migrate(dash), /statement-breakpoint/);
  const note = await project(t, { '0000_note.sql': "CREATE TABLE a (note TEXT DEFAULT 'Paused; waiting for the host' NOT NULL)" });
  assert.match((await migrate(note)).stdout, /Applied 0000_note\.sql/);
});

test('migrates the database the app resolves, and never a file database on Vercel', async (t) => {
  const dir = await project(t, { '0000_rooms.sql': 'CREATE TABLE rooms (id TEXT PRIMARY KEY)' });
  await writeFile(path.join(dir, '.env'), 'TURSO_DATABASE_URL=file:from-env.db\n');
  assert.match((await migrate(dir, { TURSO_DATABASE_URL: '' })).stdout, /Migrating file:from-env\.db/);
  assert.match((await migrate(dir, { TURSO_DATABASE_URL: 'file:from-shell.db' })).stdout, /Migrating file:from-shell\.db/);
  await assert.rejects(migrate(dir, { VERCEL: '1' }), /remote Turso database/);
});

test('two runners racing on one database apply the migration exactly once', async (t) => {
  const dir = await project(t, { '0000_rooms.sql': 'CREATE TABLE rooms (id TEXT PRIMARY KEY)' });
  // Without a busy timeout the runner that meets the other's lock exits 1, which Promise.all reports.
  const runs = await Promise.all([migrate(dir), migrate(dir)]);
  assert.equal(runs.filter(({ stdout }) => stdout.includes('Applied 0000_rooms.sql')).length, 1);
});
