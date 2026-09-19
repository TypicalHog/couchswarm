import { cleanName, getDb, hash, json, notAllowed, readBody, roomExpired, secret, withDb } from '@/lib/db';
import { validSignal, type HelperRoom, type HelperRow } from '@/lib/helper-auth';
import { iceConfiguration } from '@/lib/ice';
import { HELPER_PEER_TTL_MS, MAX_HELPER_PEERS, PRESENCE_MS } from '@/lib/sync';

export const maxDuration = 10;

async function handler(request: Request) {
  let body;
  try { body = await readBody(request, 40000); } catch { return json({ error: 'Invalid helper request.' }, 400); }
  const db = getDb();
  if (body.action === 'claim') {
    if (typeof body.code !== 'string' || !/^[a-f0-9]{64}$/.test(body.code)) return json({ error: 'Invalid pairing link.' }, 400);
    const helper = await db.prepare('SELECT helpers.*, rooms.created_at AS room_created_at FROM helpers JOIN rooms ON rooms.id = helpers.room_id WHERE pair_hash = ? AND pair_expires > ? AND token_hash IS NULL')
      .bind(await hash(body.code), Date.now()).first<HelperRow & { room_created_at: number }>();
    if (!helper || await roomExpired(db, helper.room_id, helper.room_created_at, Date.now())) return json({ error: 'That pairing link expired or was already used. Create a new one in your room.' }, 410);
    const token = secret();
    const claim = await db.prepare("UPDATE helpers SET token_hash = ?, last_seen = ?, status = 'Helper connected.' WHERE id = ? AND token_hash IS NULL AND pair_expires > ?")
      .bind(await hash(token), Date.now(), helper.id, Date.now()).run();
    if (!claim.meta.changes) return json({ error: 'That pairing link was already used.' }, 409);
    return json({ id: helper.id, roomId: helper.room_id, token, ...await iceConfiguration(helper.id) });
  }
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!/^[a-f0-9]{64}$/.test(token) || typeof body.id !== 'string') return json({ error: 'Pair the helper from your room first.' }, 403);
  const helper = await db.prepare('SELECT * FROM helpers WHERE id = ? AND token_hash = ?').bind(body.id, await hash(token)).first<HelperRow>();
  if (!helper) return json({ error: 'The helper was disconnected. Pair it again from your room.' }, 403);
  const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(helper.room_id).first<HelperRoom>();
  if (!room || await roomExpired(db, room.id, room.created_at, Date.now())) return json({ error: 'This room has expired.' }, 410);
  if (body.action === 'stop') {
    await db.batch([
      db.prepare("UPDATE helpers SET last_seen = 0, info_hash = '', status = 'Helper stopped.' WHERE id = ?").bind(helper.id),
      db.prepare('DELETE FROM helper_peers WHERE helper_id = ?').bind(helper.id),
    ]);
    return json({ ok: true });
  }
  if (body.action === 'answer') {
    const answer = validSignal(body.answer, 'answer');
    if (!answer || typeof body.peerId !== 'string') return json({ error: 'Invalid answer.' }, 400);
    const result = await db.prepare('UPDATE helper_peers SET answer = ? WHERE id = ? AND helper_id = ? AND media_version = ? AND answer IS NULL')
      .bind(JSON.stringify(answer), body.peerId, helper.id, room.media_version).run();
    return json({ ok: !!result.meta.changes }, result.meta.changes ? 200 : 410);
  }
  if (body.action !== 'poll') return json({ error: 'Unknown helper action.' }, 400);
  const current = body.mediaVersion === room.media_version;
  const infoHash = current && typeof body.infoHash === 'string' && /^[a-f0-9]{40}$/.test(body.infoHash) ? body.infoHash : '';
  await db.batch([
    db.prepare('UPDATE helpers SET last_seen = ?, status = ?, media_version = ?, info_hash = ? WHERE id = ?')
      .bind(Date.now(), cleanName(body.status, 160) || 'Helper connected.', current ? room.media_version : -1, infoHash, helper.id),
    db.prepare('DELETE FROM helper_peers WHERE helper_id = ? AND (last_seen < ? OR media_version != ?)').bind(helper.id, Date.now() - HELPER_PEER_TTL_MS, room.media_version),
  ]);
  // Present members take the slots first: a row left behind by someone who is no longer on the couch must never push a live viewer out of the list, since the agent destroys every peer missing from it.
  const peers = await db.prepare('SELECT helper_peers.id, helper_peers.offer, helper_peers.answer FROM helper_peers LEFT JOIN members ON members.id = helper_peers.member_id WHERE helper_peers.helper_id = ? ORDER BY (members.last_seen > ?) DESC, helper_peers.last_seen DESC LIMIT ?')
    .bind(helper.id, Date.now() - PRESENCE_MS, MAX_HELPER_PEERS).all<{ id: string; offer: string; answer: string | null }>();
  return json({ room: { id: room.id, source: room.source, mediaVersion: room.media_version, fileIndex: room.file_index },
    peers: peers.results.map(peer => ({ id: peer.id, offer: peer.answer ? null : JSON.parse(peer.offer), answered: !!peer.answer })), ...await iceConfiguration(helper.id) });
}

export const POST = withDb(handler);
export const GET = notAllowed, PUT = notAllowed, DELETE = notAllowed, PATCH = notAllowed;
