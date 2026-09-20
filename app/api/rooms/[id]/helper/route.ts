import { hash, json, notAllowed, readBody, secret, withDb } from '@/lib/db';
import { roomAccess, validSignal, type HelperRow } from '@/lib/helper-auth';
import { iceConfiguration } from '@/lib/ice';
import { HELPER_ONLINE_MS, HELPER_PEER_TTL_MS, MAX_HELPER_PEERS, PAIR_TTL_MS, PRESENCE_MS } from '@/lib/sync';

export const maxDuration = 10;

async function handler(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await roomAccess(request, (await context.params).id);
  if (!access) return json({ error: 'This room session has expired.' }, 403);
  const { db, room, memberId, present } = access;
  let body;
  try { body = await readBody(request, 40000); } catch { return json({ error: 'Invalid helper request.' }, 400); }
  // Keeping a connection alive needs none of the helper selection below, and it repeats every five seconds, so answer it first.
  if (body.action === 'peer' || body.action === 'close') {
    if (typeof body.peerId !== 'string') return json({ error: 'Invalid connection.' }, 400);
    // An open connection outlives helper selection: a guest keeps the host's helper until their own is ready.
    const peer = await db.prepare('SELECT helper_peers.answer FROM helper_peers JOIN helpers ON helpers.id = helper_peers.helper_id WHERE helper_peers.id = ? AND helper_peers.member_id = ? AND helpers.room_id = ? AND helper_peers.media_version = ?')
      .bind(body.peerId, memberId, room.id, room.media_version).first<{ answer: string | null }>();
    if (!peer) return json({ error: 'The helper connection has expired.' }, 410);
    if (body.action === 'close') {
      await db.prepare('DELETE FROM helper_peers WHERE id = ?').bind(body.peerId).run();
      return json({ ok: true });
    }
    await db.prepare('UPDATE helper_peers SET last_seen = ? WHERE id = ?').bind(Date.now(), body.peerId).run();
    return json({ answer: peer.answer ? JSON.parse(peer.answer) : null });
  }
  const { results } = await db.prepare('SELECT * FROM helpers WHERE room_id = ? AND member_id IN (?, ?)').bind(room.id, memberId, room.host_id).all<HelperRow>();
  const mine = results.find(row => row.member_id === memberId);
  const hosts = results.find(row => row.member_id === room.host_id);
  const isOnline = (row?: HelperRow) => !!row?.token_hash && row.last_seen > Date.now() - HELPER_ONLINE_MS;
  const isReady = (row?: HelperRow) => isOnline(row) && row!.media_version === room.media_version && /^[a-f0-9]{40}$/.test(row!.info_hash);
  // A participant's own helper serves them once it can actually serve. Everyone else streams from the host's helper.
  const helper = isReady(mine) ? mine : isReady(hosts) ? hosts : isOnline(mine) ? mine : hosts?.token_hash ? hosts : mine;
  const own = !!helper?.token_hash && helper === mine;
  const online = isOnline(helper);
  const ready = isReady(helper);
  if (body.action === 'status') return json({ paired: !!helper?.token_hash, online, ready, own, mine: !!mine?.token_hash,
    mineOnline: isOnline(mine), mineStatus: mine?.status || '',
    status: helper?.status || 'Connect a helper to reach ordinary torrent peers.',
    infoHash: ready ? helper!.info_hash : '',
    downloadUrl: process.env.COUCHSWARM_HELPER_DOWNLOAD_URL || '',
    downloadUrlLinux: process.env.COUCHSWARM_HELPER_DOWNLOAD_URL_LINUX || '',
    ...await iceConfiguration(memberId) });
  if (body.action === 'pair' && isOnline(mine)) return json({ error: 'Your helper is connected. Disconnect it before pairing another one.' }, 409);
  if (body.action === 'pair' || body.action === 'unpair') {
    const code = secret();
    const url = new URL(request.url);
    // x-forwarded-host is caller-controlled (Next fills it in from Host) and url.hostname is only this server's listen address, so build the link from Host; a proxy that rewrites Host needs COUCHSWARM_PUBLIC_ORIGIN (distinct from the standalone helper’s COUCHSWARM_ORIGIN).
    const origin = process.env.COUCHSWARM_PUBLIC_ORIGIN || `${url.protocol}//${request.headers.get('host') || url.host}`;
    const statements = [
      db.prepare('DELETE FROM helper_peers WHERE helper_id IN (SELECT id FROM helpers WHERE room_id = ? AND member_id = ?)').bind(room.id, memberId),
      db.prepare('DELETE FROM helpers WHERE room_id = ? AND member_id = ?').bind(room.id, memberId),
    ];
    if (body.action === 'pair') statements.push(db.prepare('INSERT INTO helpers (id, room_id, member_id, pair_hash, pair_expires) VALUES (?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), room.id, memberId, await hash(code), Date.now() + PAIR_TTL_MS));
    await db.batch(statements);
    return json(body.action === 'pair' ? { pairingUrl: `${origin}/#helper=${code}`, expiresIn: PAIR_TTL_MS / 1000 } : { ok: true });
  }
  if (body.action === 'offer') {
    // A seat that has lapsed holds no helper connection either; 409 rather than 403, because the session is still valid and should retry once its seat is back.
    if (!present) return json({ error: 'Rejoin the room to use the helper.' }, 409);
    if (!helper || !ready) return json({ error: `${own ? 'Your' : 'The host’s'} helper is not ready yet.` }, 409);
    const offer = validSignal(body.offer, 'offer');
    if (body.mediaVersion !== room.media_version || !offer) return json({ error: 'This connection request is stale or invalid.' }, 409);
    const active = await db.prepare('SELECT COUNT(*) AS count FROM helper_peers WHERE helper_id = ? AND member_id != ? AND last_seen > ? AND EXISTS (SELECT 1 FROM members WHERE members.id = helper_peers.member_id AND members.last_seen > ?)').bind(helper.id, memberId, Date.now() - HELPER_PEER_TTL_MS, Date.now() - PRESENCE_MS).first<{ count: number }>();
    if ((active?.count || 0) >= MAX_HELPER_PEERS) return json({ error: 'All helper connections are in use.' }, 429);
    const peerId = crypto.randomUUID();
    await db.batch([
      db.prepare('DELETE FROM helper_peers WHERE member_id = ?').bind(memberId),
      db.prepare('INSERT INTO helper_peers (id, helper_id, member_id, media_version, offer, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(peerId, helper.id, memberId, room.media_version, JSON.stringify(offer), Date.now()),
    ]);
    return json({ peerId }, 201);
  }
  return json({ error: 'Unknown helper action.' }, 400);
}

export const POST = withDb(handler);
export const GET = notAllowed, PUT = notAllowed, DELETE = notAllowed, PATCH = notAllowed;
