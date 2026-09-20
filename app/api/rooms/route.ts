import { cleanName, getDb, hash, json, notAllowed, readBody, secret, withDb } from '@/lib/db';
import { PRESENCE_MS, ROOM_TTL_MS, validSource } from '@/lib/sync';

export const maxDuration = 10;

const expiredRooms = 'SELECT id FROM rooms WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM members WHERE members.room_id = rooms.id AND members.last_seen > ?)';

async function handler(request: Request) {
  let body;
  try { body = await readBody(request); } catch { return json({ error: 'Invalid room request.' }, 400); }
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (source && !validSource(source)) return json({ error: 'Enter a valid magnet link or HTTPS .torrent URL.' }, 400);
  const name = cleanName(body.name) || 'Host';
  const id = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const token = secret();
  const invite = secret();
  const hostKey = secret();
  const [tokenHash, inviteHash, hostKeyHash] = await Promise.all([hash(token), hash(invite), hash(hostKey)]);
  const db = getDb();
  const now = Date.now();
  const cutoff = now - ROOM_TTL_MS, seen = now - PRESENCE_MS;
  await db.batch([
    db.prepare(`DELETE FROM helper_peers WHERE helper_id IN (SELECT id FROM helpers WHERE room_id IN (${expiredRooms}))`).bind(cutoff, seen),
    db.prepare(`DELETE FROM helpers WHERE room_id IN (${expiredRooms})`).bind(cutoff, seen),
    db.prepare(`DELETE FROM members WHERE room_id IN (${expiredRooms})`).bind(cutoff, seen),
    db.prepare(`DELETE FROM rooms WHERE id IN (${expiredRooms})`).bind(cutoff, seen),
    // A pairing link nobody used can no longer be claimed, so its row only waits out the room's day.
    db.prepare('DELETE FROM helpers WHERE token_hash IS NULL AND pair_expires < ?').bind(now),
    db.prepare('INSERT INTO rooms (id, name, host_id, invite_hash, host_key_hash, source, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, 'The living room', memberId, inviteHash, hostKeyHash, source, source ? 'Buffering a new movie.' : 'Waiting for a movie.', now),
    db.prepare('INSERT INTO members (id, room_id, token_hash, name, last_seen, joined_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(memberId, id, tokenHash, name, now, now),
  ]);
  return json({ roomId: id, memberId, token, invite, hostKey }, 201);
}

export const POST = withDb(handler);
export const GET = notAllowed, PUT = notAllowed, DELETE = notAllowed, PATCH = notAllowed;
