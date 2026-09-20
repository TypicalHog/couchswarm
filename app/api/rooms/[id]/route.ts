import { cleanName, getDb, hash, json, notAllowed, readBody, roomExpired, secret, withDb, type RunResult } from '@/lib/db';
import { allReady, MAX_SEATS, PRESENCE_MS, SPECTATOR_EPOCH, timelinePosition, validSource, type Member, type Room } from '@/lib/sync';

export const maxDuration = 10;

const BUFFERING = 'Someone is buffering. Waiting for everyone.';
const HOST_AWAY = 'The host disconnected. Waiting for them to return.';

type StoredRoom = {
  id: string; name: string; host_id: string; invite_hash: string; host_key_hash: string; source: string;
  file_index: number; media_version: number; epoch: number; revision: number;
  playing: number; position: number; starts_at: number; duration: number; reason: string; created_at: number;
};
type StoredMember = { id: string; name: string; ready: number; buffered: number; epoch: number; last_seen: number };

function publicRoom(row: StoredRoom): Room {
  return { id: row.id, hostId: row.host_id, source: row.source, fileIndex: row.file_index,
    mediaVersion: row.media_version, epoch: row.epoch, revision: row.revision, playing: !!row.playing,
    position: row.position, startsAt: row.starts_at, duration: row.duration, reason: row.reason,
    // Enough of the hash for a tab to recognise its own invite, and far too little to attack the secret behind it.
    inviteTag: row.invite_hash.slice(0, 16) };
}

function number(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

async function handler(request: Request, context: { params: Promise<{ id: string }> }) {
  const serverReceivedAt = Date.now();
  const { id } = await context.params;
  const db = getDb();
  let stored = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<StoredRoom>();
  if (!stored) return json({ error: 'This room does not exist. Check your invite link.' }, 404);
  if (await roomExpired(db, id, stored.created_at, Date.now())) {
    await db.batch([
      db.prepare('DELETE FROM helper_peers WHERE helper_id IN (SELECT id FROM helpers WHERE room_id = ?)').bind(id),
      db.prepare('DELETE FROM helpers WHERE room_id = ?').bind(id),
      db.prepare('DELETE FROM members WHERE room_id = ?').bind(id),
      db.prepare('DELETE FROM rooms WHERE id = ?').bind(id),
    ]);
    return json({ error: 'This room has expired. Create a new room for tonight.' }, 410);
  }
  let body;
  try { body = await readBody(request); } catch { return json({ error: 'Invalid room request.' }, 400); }
  const now = Date.now();
  // Every action below must be named here, or it is refused before any authority check runs.
  if (typeof body.action !== 'string' || !['join', 'snapshot', 'heartbeat', 'leave', 'source', 'file', 'play', 'pause', 'seek', 'kick', 'rotate'].includes(body.action)) return json({ error: 'Unknown room action.' }, 400);
  if (body.action === 'join') {
    if (typeof body.invite !== 'string' || await hash(body.invite) !== stored.invite_hash) return json({ error: 'This invite link is invalid.' }, 403);
    const token = secret();
    const name = cleanName(body.name);
    if (!name) return json({ error: 'Enter your name to join.' }, 400);
    // Counted by when the seat was taken, not by what became of it: leaving zeroes last_seen and frees the seat, so
    // a join-then-leave loop otherwise passes both this and the seat cap and grows the table as fast as it can post.
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id = ? AND joined_at > ?').bind(id, now - 60_000).first<{ n: number }>();
    if ((recent?.n ?? 0) >= 24) return json({ error: 'Too many joins. Try again in a minute.' }, 429);
    const host = stored.playing ? await db.prepare('SELECT last_seen FROM members WHERE id = ? AND last_seen > 0').bind(stored.host_id).first<{ last_seen: number }>() : null;
    // The host comes back to the seat they already own, never to a new one: the room can never resume without
    // them, so a full couch must not refuse them, and the room's helper stays bound to that member id.
    const reclaim = typeof body.hostKey === 'string' && body.hostKey.length === 64 && await hash(body.hostKey) === stored.host_key_hash;
    const memberId = reclaim ? stored.host_id : crypto.randomUUID();
    if (reclaim) {
      await db.prepare('UPDATE members SET token_hash = ?, name = ?, ready = 0, buffered = 0, epoch = -1, last_seen = ?, report_sequence = 0 WHERE id = ?')
        .bind(await hash(token), name, now, memberId).run();
    } else {
      const result = await db.prepare('INSERT INTO members (id, room_id, token_hash, name, last_seen, joined_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM members WHERE room_id = ? AND last_seen > ?) < ?')
        .bind(memberId, id, await hash(token), name, now, now, id, now - PRESENCE_MS, MAX_SEATS).run();
      if (!result.meta.changes) return json({ error: `This couch is full (${MAX_SEATS} people). Try again when a seat opens.` }, 409);
    }
    // Nobody is waiting on the new arrival's buffer if the host is already gone: the room stopped at the lease,
    // and only this join is here to say so, because the lease check never runs for a room that is paused.
    const away = !host || host.last_seen <= now - PRESENCE_MS;
    const pausedAt = host && away ? host.last_seen + PRESENCE_MS : now;
    // The room was read several round trips ago, so pause only the timeline this position was worked out from:
    // a pause and a restart in between would put the movie back where it never was, and the joiner's own first
    // report pauses the room anyway.
    await db.prepare('UPDATE rooms SET playing = 0, position = ?, reason = ?, revision = revision + 1 WHERE id = ? AND playing = 1 AND revision = ?')
      .bind(timelinePosition(publicRoom(stored), pausedAt), away && !reclaim ? HOST_AWAY : 'A friend joined. Waiting for their buffer.', id, stored.revision).run();
    return json({ roomId: id, memberId, token, invite: body.invite }, 201);
  }
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'Reopen your invite link to join this room.' }, 401);
  // Leaving is final: the last_seen = 0 marker retires the token with the seat, so a copy of it opens nothing here.
  const actor = await db.prepare('SELECT id, ready, buffered, epoch, last_seen, report_sequence FROM members WHERE room_id = ? AND token_hash = ? AND last_seen > 0')
    .bind(id, await hash(token)).first<{ id: string; ready: number; buffered: number; epoch: number; last_seen: number; report_sequence: number }>();
  if (!actor) return json({ error: 'Your seat has expired. Join the room again.' }, 401);

  // Evaluate the old lease before a returning host can renew it.
  let lapsed = false;
  if (stored.playing) {
    // A host who left carries the last_seen = 0 marker, not a timestamp: read them as gone, or the lease
    // arithmetic below rewinds the room to its last play or seek.
    const host = await db.prepare('SELECT last_seen FROM members WHERE id = ? AND last_seen > 0').bind(stored.host_id).first<{ last_seen: number }>();
    if (!host || host.last_seen <= now - PRESENCE_MS) {
      const stoppedAt = host ? Math.min(now, host.last_seen + PRESENCE_MS) : now;
      await db.prepare('UPDATE rooms SET playing = 0, position = ?, revision = revision + 1, reason = ? WHERE id = ? AND revision = ?')
        .bind(timelinePosition(publicRoom(stored), stoppedAt), HOST_AWAY, id, stored.revision).run();
      stored = (await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<StoredRoom>())!;
      lapsed = true;
    }
  }

  const readMembers = async (): Promise<Member[]> => {
    const { results } = await db.prepare('SELECT id, name, ready, buffered, epoch, last_seen FROM members WHERE room_id = ? AND last_seen > ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, rowid')
      .bind(id, Date.now() - PRESENCE_MS, stored!.host_id).all<StoredMember>();
    return results.map(m => ({ id: m.id, name: m.name, ready: !!m.ready, buffered: m.buffered, epoch: m.epoch, lastSeen: m.last_seen }));
  };

  let invite = '', hostKey = '', roomChanged = false;
  if (body.action === 'heartbeat') {
    if (typeof body.sequence !== 'number' || !Number.isSafeInteger(body.sequence) || body.sequence < 0) return json({ error: 'Invalid report.' }, 400);
    const duration = number(body.duration, 0, 604800);
    const epoch = number(body.epoch, -1, 1e9);
    const ready = body.ready === true ? 1 : 0;
    const buffered = number(body.buffered, 0, 604800);
    // A seat reporting every second all evening is most of what a room costs, so a report that would store the
    // values already on the row is counted and never written: the clock still moves every 3 s against a 12 s
    // presence window, and a buffered second nobody can see is not worth a write. A member the room has moved
    // past, or one whose epoch changed, matches none of this and goes through the statement below.
    let accepted = actor.ready === ready && actor.epoch === epoch && Math.trunc(actor.buffered) === Math.trunc(buffered)
      && actor.last_seen > now - 3000 && actor.report_sequence < body.sequence;
    if (!accepted) {
      // A lapsed seat comes back as a spectator (never the host, who owns the timeline) and only retakes its seat by
      // reporting ready at the epoch the room is on: a tab that wakes with an old snapshot is ready for a scene the
      // room has left, and seating it there would pause everyone. It cannot take a seat the room no longer has —
      // except the host's own seat, which the room can never resume without.
      const report = await db.prepare('UPDATE members SET ready = ?, buffered = ?, epoch = CASE WHEN ? OR ((? OR epoch != ?) AND last_seen > ?) THEN ? ELSE ? END, last_seen = ?, report_sequence = ? WHERE id = ? AND (report_sequence < ? OR (last_seen > 0 AND last_seen < ?)) AND (last_seen > ? OR ? = ? OR (SELECT COUNT(*) FROM members WHERE room_id = ? AND last_seen > ?) < ?)')
        .bind(ready, buffered, actor.id === stored.host_id ? 1 : 0, ready && epoch === stored.epoch ? 1 : 0, SPECTATOR_EPOCH, now - PRESENCE_MS, epoch, SPECTATOR_EPOCH, now, body.sequence,
          actor.id, body.sequence, now - 2000, now - PRESENCE_MS, actor.id, stored.host_id, id, now - PRESENCE_MS, MAX_SEATS).run();
      accepted = !!report.meta.changes;
      // This seat is gone, but the tab keeps asking for it and takes it back the moment one frees up, so the
      // code lets the client say that instead of reading the refusal as a connection it has to repair.
      if (!accepted && actor.last_seen <= now - PRESENCE_MS) return json({ error: `This couch is full (${MAX_SEATS} people). We’ll bring you back when a seat opens.`, code: 'seat-lost' }, 409);
    }
    // The room row is already in hand, so a host restating the duration it reported a second ago is answered without
    // asking Turso anything. The statement keeps the same tests for the writer that moved the room in the meantime.
    if (accepted && actor.id === stored.host_id && duration > 0 && body.mediaVersion === stored.media_version
      && duration !== stored.duration && (!stored.playing || !stored.duration || duration >= stored.duration))
      roomChanged = !!(await db.prepare('UPDATE rooms SET duration = ? WHERE id = ? AND media_version = ? AND duration != ? AND (playing = 0 OR duration = 0 OR ? >= duration)')
        .bind(duration, id, stored.media_version, duration, duration).run()).meta.changes;
  } else if (body.action === 'leave') {
    await db.batch([
      db.prepare('UPDATE members SET last_seen = 0, ready = 0, report_sequence = ? WHERE id = ?').bind(Number.MAX_SAFE_INTEGER, actor.id),
      db.prepare('DELETE FROM helper_peers WHERE helper_id IN (SELECT id FROM helpers WHERE room_id = ?) AND (member_id = ? OR helper_id IN (SELECT id FROM helpers WHERE member_id = ?))').bind(id, actor.id, actor.id),
      db.prepare('DELETE FROM helpers WHERE room_id = ? AND member_id = ?').bind(id, actor.id),
    ]);
  } else if (body.action !== 'snapshot') {
    if (actor.id !== stored.host_id) return json({ error: 'Only the host can control playback.' }, 403);
    if (body.revision !== stored.revision) return json({ error: 'The room changed. Try that again.' }, 409);
    let result: RunResult;
    if (body.action === 'source') {
      if (!validSource(body.source)) return json({ error: 'Enter a valid magnet link or HTTPS .torrent URL.' }, 400);
      result = await db.prepare('UPDATE rooms SET source = ?, file_index = 0, media_version = media_version + 1, epoch = epoch + 1, revision = revision + 1, playing = 0, position = 0, starts_at = 0, duration = 0, reason = ? WHERE id = ? AND revision = ?')
        .bind(body.source, 'Buffering a new movie.', id, stored.revision).run();
    } else if (body.action === 'file') {
      if (!Number.isInteger(body.fileIndex) || Number(body.fileIndex) < 0 || Number(body.fileIndex) > 10000) return json({ error: 'Invalid video selection.' }, 400);
      if (Number(body.fileIndex) === stored.file_index) return json({ room: publicRoom(stored), members: await readMembers(), serverNow: Date.now(), serverReceivedAt });
      result = await db.prepare('UPDATE rooms SET file_index = ?, media_version = media_version + 1, epoch = epoch + 1, revision = revision + 1, playing = 0, position = 0, duration = 0, reason = ? WHERE id = ? AND revision = ?')
        .bind(body.fileIndex, 'Buffering the selected video.', id, stored.revision).run();
    } else if (body.action === 'play') {
      const members = await readMembers();
      if (!stored.source || stored.duration <= 0 || !allReady(members, publicRoom(stored), now)) return json({ error: 'Wait for everyone to buffer before pressing play.' }, 409);
      if (stored.position >= stored.duration) {
        result = await db.prepare('UPDATE rooms SET playing = 0, position = 0, epoch = epoch + 1, revision = revision + 1, reason = ? WHERE id = ? AND revision = ? AND playing = 0')
          .bind('Back to the start. Press play once everyone is ready.', id, stored.revision).run();
      } else {
        result = await db.prepare('UPDATE rooms SET playing = 1, starts_at = ?, revision = revision + 1, reason = ? WHERE id = ? AND revision = ? AND playing = 0 AND NOT EXISTS (SELECT 1 FROM members WHERE room_id = ? AND last_seen > ? AND epoch != ? AND (ready = 0 OR epoch != ?))')
          .bind(now + 3000, 'Playing together.', id, stored.revision, id, now - PRESENCE_MS, SPECTATOR_EPOCH, stored.epoch).run();
      }
    } else if (body.action === 'pause') {
      result = await db.prepare('UPDATE rooms SET playing = 0, position = ?, revision = revision + 1, reason = ? WHERE id = ? AND revision = ?')
        .bind(timelinePosition(publicRoom(stored), now), 'Paused by the host.', id, stored.revision).run();
    } else if (body.action === 'seek') {
      if (!stored.source || stored.duration <= 0) return json({ error: 'Wait for the movie to load before seeking.' }, 409);
      if (typeof body.position !== 'number' || !Number.isFinite(body.position)) return json({ error: 'Invalid seek position.' }, 400);
      const position = number(body.position, 0, stored.duration);
      result = await db.prepare('UPDATE rooms SET playing = 0, position = ?, epoch = epoch + 1, revision = revision + 1, reason = ? WHERE id = ? AND revision = ?')
        .bind(position, 'Finding your place. Waiting for everyone to buffer.', id, stored.revision).run();
    } else if (body.action === 'kick') {
      if (typeof body.memberId !== 'string' || body.memberId === stored.host_id || !await db.prepare('SELECT 1 AS n FROM members WHERE id = ? AND room_id = ?').bind(body.memberId, id).first<{ n: number }>()) return json({ error: 'Choose someone to remove.' }, 400);
      const removal = await db.batch([
        db.prepare('DELETE FROM helper_peers WHERE helper_id IN (SELECT id FROM helpers WHERE room_id = ?) AND (member_id = ? OR helper_id IN (SELECT id FROM helpers WHERE member_id = ?)) AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND revision = ?)').bind(id, body.memberId, body.memberId, id, stored.revision),
        db.prepare('DELETE FROM helpers WHERE room_id = ? AND member_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND revision = ?)').bind(id, body.memberId, id, stored.revision),
        db.prepare('DELETE FROM members WHERE id = ? AND room_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND revision = ?)').bind(body.memberId, id, id, stored.revision),
        db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ? AND revision = ?').bind(id, stored.revision),
      ]);
      result = removal[3];
    } else if (body.action === 'rotate') {
      // The host re-claim key is reissued with the invite: a leaked key is only revocable here.
      invite = secret();
      hostKey = secret();
      // Every seat taken with the old link goes with it, lapsed ones included: a token banked from that link
      // would otherwise heartbeat its way back into the room the host just cleared.
      const rotation = await db.batch([
        db.prepare('DELETE FROM helper_peers WHERE helper_id IN (SELECT id FROM helpers WHERE room_id = ?) AND (member_id != ? OR helper_id IN (SELECT id FROM helpers WHERE room_id = ? AND member_id != ?)) AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND revision = ?)').bind(id, stored.host_id, id, stored.host_id, id, stored.revision),
        db.prepare('DELETE FROM helpers WHERE room_id = ? AND member_id != ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND revision = ?)').bind(id, stored.host_id, id, stored.revision),
        db.prepare('DELETE FROM members WHERE room_id = ? AND id != ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND revision = ?)').bind(id, stored.host_id, id, stored.revision),
        db.prepare('UPDATE rooms SET invite_hash = ?, host_key_hash = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
          .bind(await hash(invite), await hash(hostKey), id, stored.revision),
      ]);
      result = rotation[3];
    } else return json({ error: 'Unknown room action.' }, 400);
    if (!result.meta.changes) return json({ error: 'The room changed. Try again when everyone is ready.' }, 409);
    roomChanged = true;
  }

  // Only this request can have moved the room on; a guest heartbeat re-reading it is a round trip for nothing.
  if (roomChanged) stored = (await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<StoredRoom>())!;
  let room = publicRoom(stored);
  const members = await readMembers();
  if (room.playing && (!allReady(members, room, Date.now()) || timelinePosition(room, Date.now()) >= room.duration)) {
    const hostPresent = members.some(m => m.id === room.hostId);
    const ended = room.duration > 0 && timelinePosition(room, Date.now()) >= room.duration;
    const reason = ended ? 'That’s a wrap. Ready for another?' : hostPresent ? BUFFERING : HOST_AWAY;
    await db.prepare('UPDATE rooms SET playing = 0, position = ?, revision = revision + 1, reason = ? WHERE id = ? AND revision = ?')
      .bind(timelinePosition(room, Date.now()), reason, id, room.revision).run();
    stored = (await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<StoredRoom>())!;
    room = publicRoom(stored);
  } else if (!room.playing && room.reason === BUFFERING && allReady(members, room, Date.now())) {
    await db.prepare('UPDATE rooms SET playing = 1, starts_at = ?, revision = revision + 1, reason = ? WHERE id = ? AND revision = ? AND playing = 0')
      .bind(Date.now() + 3000, 'Playing together.', id, room.revision).run();
    stored = (await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<StoredRoom>())!;
    room = publicRoom(stored);
  } else if (!room.playing && !lapsed && room.reason === HOST_AWAY && members.some(m => m.id === room.hostId)) {
    // Nothing used to take that message back, so the couch read 'waiting for them to return' at a host who was
    // sitting right there, and only a control action cleared it. The room still does not restart itself: a lease
    // that lapsed is the host's to resume. The request that stopped the room keeps the message, because it is
    // the one that has to explain where the movie stopped.
    await db.prepare('UPDATE rooms SET revision = revision + 1, reason = ? WHERE id = ? AND revision = ? AND playing = 0')
      .bind('The host is back. Waiting for them to press play.', id, room.revision).run();
    stored = (await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<StoredRoom>())!;
    room = publicRoom(stored);
  }
  return json({ room, members, serverNow: Date.now(), serverReceivedAt, ...(invite ? { invite } : {}), ...(hostKey ? { hostKey } : {}) });
}

export const POST = withDb(handler);
export const GET = notAllowed, PUT = notAllowed, DELETE = notAllowed, PATCH = notAllowed;
