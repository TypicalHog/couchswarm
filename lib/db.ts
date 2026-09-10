import { getDatabase } from '@/lib/database-node';
import { PRESENCE_MS, ROOM_TTL_MS } from '@/lib/sync';

export type RunResult = { meta: { changes: number } };
export type Stmt = { bind(...values: unknown[]): Stmt; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<RunResult> };
export type Db = { prepare(sql: string): Stmt; batch(statements: Stmt[]): Promise<RunResult[]> };

export function getDb(): Db {
  return getDatabase();
}

// A room outlives its 24 hours while anyone is still on the couch.
export async function roomExpired(db: Db, roomId: string, createdAt: number, now: number) {
  return now - createdAt > ROOM_TTL_MS && !await db.prepare('SELECT 1 AS n FROM members WHERE room_id = ? AND last_seen > ?').bind(roomId, now - PRESENCE_MS).first<{ n: number }>();
}

export function secret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function cleanName(value: unknown, max = 24) {
  const text = String(typeof value === 'string' || typeof value === 'number' ? value : '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return Array.from(text).slice(0, max).join('');
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function notAllowed() {
  return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
}

export async function readBody(request: Request, limit = 12000): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new Error('Invalid request.');
  if (Number(request.headers.get('content-length')) > limit) throw new Error('Request is too large.');
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new Error('Request is too large.'); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value;
}
