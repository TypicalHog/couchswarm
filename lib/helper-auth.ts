import { getDb, hash, roomExpired } from '@/lib/db';
import { PRESENCE_MS } from '@/lib/sync';

export type HelperRow = { id: string; room_id: string; member_id: string; token_hash: string | null; last_seen: number; status: string; media_version: number; info_hash: string };
export type HelperRoom = { id: string; host_id: string; source: string; media_version: number; file_index: number; created_at: number };
export async function roomAccess(request: Request, id: string) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const db = getDb();
  const member = await db.prepare('SELECT id, last_seen FROM members WHERE room_id = ? AND token_hash = ?').bind(id, await hash(token)).first<{ id: string; last_seen: number }>();
  const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<HelperRoom>();
  if (!member || !room || await roomExpired(db, room.id, room.created_at, Date.now())) return null;
  return { db, room, memberId: member.id, present: member.last_seen > Date.now() - PRESENCE_MS };
}
export function validSignal(value: unknown, type: string): { type: string; sdp: string } | null {
  if (!value || typeof value !== 'object') return null;
  const signal = value as Record<string, unknown>;
  if (signal.type !== type || typeof signal.sdp !== 'string' || !signal.sdp.length || signal.sdp.length > 32000) return null;
  return { type, sdp: signal.sdp };
}
