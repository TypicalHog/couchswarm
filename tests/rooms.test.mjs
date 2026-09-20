import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const origin = process.env.TEST_ORIGIN || 'http://localhost:3001';
const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
async function post(path, body, token, expected = 200) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    .catch(error => { throw new Error(`POST ${origin + path}: ${error.message}`); });
  // A dev-overlay 500, a 404 page or a proxy answers HTML, and parsing that before the status assertion throws a
  // SyntaxError inside this helper with no status, route or body to go on.
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* reported below, together with the status */ }
  const detail = `POST ${origin + path}${body.action ? ` ${body.action}` : ''}: HTTP ${response.status} ${response.headers.get('content-type')}: ${text.slice(0, 200)}`;
  assert.equal(response.status, expected, data?.error || detail);
  assert.ok(data, detail);
  return data;
}

test('room invites, authority, buffering gate, timeline, stale messages, seeking, and late joins', { timeout: 30000 }, async t => {
  await post('/api/rooms', { source: 'invalid' }, undefined, 400);
  const host = await post('/api/rooms', { source: magnet }, undefined, 201);
  const path = `/api/rooms/${host.roomId}`;
  const call = (body, expected = 200) => post(path, body, host.token, expected);
  t.after(() => post(path, { action: 'leave' }, host.token).catch(() => {}));
  await post(path, { action: 'snapshot' }, undefined, 401);
  await post(path, { action: 'join', invite: 'wrong', name: 'Guest' }, undefined, 403);
  let state = await call({ action: 'snapshot' });
  assert.equal(state.members.length, 1);
  assert.equal(state.room.reason, 'Buffering a new movie.', 'a room created with a source starts out buffering that movie');
  assert.equal(JSON.stringify(state).includes(host.token), false);
  await call({ action: 'play', revision: state.room.revision }, 409);
  const heartbeat = (token, sequence, epoch = 0, ready = true, mediaVersion = 0) => post(path, { action: 'heartbeat', ready, buffered: 15, progress: .1, epoch, mediaVersion, duration: 120, sequence }, token);
  state = await heartbeat(host.token, 1);
  assert.equal(state.room.duration, 120);
  state = await call({ action: 'play', revision: state.room.revision });
  assert.equal(state.room.playing, true);
  assert.ok(state.room.startsAt > state.serverNow);
  const guest = await post(path, { action: 'join', invite: host.invite, name: 'Guest' }, undefined, 201);
  t.after(() => post(path, { action: 'leave' }, guest.token).catch(() => {}));
  state = await call({ action: 'snapshot' });
  assert.equal(state.room.playing, false, 'a late join cancels the pending start');
  assert.equal(state.room.reason, 'A friend joined. Waiting for their buffer.', 'the join itself cancelled the start, not the buffering reconciler');
  assert.equal(state.members.length, 2);
  await post(path, { action: 'play', revision: state.room.revision }, guest.token, 403);
  await call({ action: 'play', revision: state.room.revision }, 409);
  await heartbeat(guest.token, 2);
  state = await call({ action: 'play', revision: state.room.revision });
  assert.equal(state.room.playing, true, state.room.reason);
  const oldRevision = state.room.revision;
  state = await heartbeat(guest.token, 3, 0, false);
  assert.equal(state.room.playing, false, 'buffer loss pauses the room');
  state = await heartbeat(guest.token, 2, 0, true);
  assert.equal(state.members.find(m => m.id === guest.memberId).ready, false, 'old heartbeat cannot restore readiness');
  assert.match((await call({ action: 'play', revision: oldRevision }, 409)).error, /The room changed/, 'the stale revision is what refuses this, not the buffer gate');
  state = await heartbeat(guest.token, 4);
  assert.equal(state.room.playing, true, 'the room resumes itself once everyone has buffered again');
  state = await call({ action: 'pause', revision: state.room.revision });
  assert.equal(state.room.playing, false);
  await new Promise(resolve => setTimeout(resolve, 2100));
  state = await heartbeat(guest.token, 2, 0, false);
  assert.equal(state.members.find(m => m.id === guest.memberId).ready, false, 'a stale sequence is accepted again once the member has been quiet for 2 s');
  state = await call({ action: 'seek', position: 60, revision: state.room.revision });
  assert.equal(state.room.position, 60);
  assert.equal(state.room.epoch, 1);
  await call({ action: 'play', revision: state.room.revision }, 409);
  await heartbeat(host.token, 5, 1);
  await heartbeat(guest.token, 5, 1);
  state = await call({ action: 'play', revision: state.room.revision });
  assert.equal(state.room.playing, true, state.room.reason);
  assert.equal(state.room.position, 60);
  state = await call({ action: 'source', source: magnet, revision: state.room.revision });
  assert.equal(state.room.position, 0);
  assert.equal(state.room.duration, 0);
  assert.equal(state.room.mediaVersion, 1);
  assert.equal(state.room.playing, false);
  state = await heartbeat(host.token, 6, 2, true, 0);
  assert.equal(state.room.duration, 0, 'a heartbeat from the previous movie cannot pin its duration');
  state = await heartbeat(host.token, 7, 2, true, 1);
  assert.equal(state.room.duration, 120, 'the current movie adopts the duration the host reports');
  await post(path, { action: 'leave' }, guest.token);
  state = await call({ action: 'snapshot' });
  assert.equal(state.members.length, 1);
  await post(path, { action: 'heartbeat', ready: true, buffered: 15, epoch: 2, mediaVersion: 1, duration: 120, sequence: Number.MAX_SAFE_INTEGER }, guest.token, 401);
  await post(path, { action: 'snapshot' }, guest.token, 401);
  await post(`${path}/helper`, { action: 'status' }, guest.token, 403);
  await call({ action: 'leave' });
});

test('rejects malformed requests, rewinds at the end, and gates seats, moderation and methods', { timeout: 60000 }, async t => {
  const host = await post('/api/rooms', { source: magnet }, undefined, 201);
  const path = `/api/rooms/${host.roomId}`;
  const call = (body, expected = 200) => post(path, body, host.token, expected);
  t.after(() => post(path, { action: 'leave' }, host.token).catch(() => {}));
  const beat = (token, sequence, extra = {}) => post(path, { action: 'heartbeat', ready: true, buffered: 15, progress: .1, epoch: 0, mediaVersion: 0, duration: 120, sequence, ...extra }, token);
  const raw = (body, contentType = 'application/json') => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${host.token}` }, body, signal: AbortSignal.timeout(10000) });
  assert.match(host.hostKey, /^[a-f0-9]{64}$/);
  await call({ action: 'sing' }, 400);
  await call({}, 400);
  assert.equal((await raw(JSON.stringify({ action: 'snapshot' }), 'text/plain')).status, 400);
  assert.equal((await raw(JSON.stringify({ action: 'snapshot', pad: 'x'.repeat(12000) }))).status, 400);
  await call({ action: 'heartbeat', sequence: '5' }, 400);
  await call({ action: 'heartbeat', sequence: 1e300 }, 400);
  let state = await call({ action: 'snapshot' });
  await call({ action: 'seek', position: 10, revision: state.room.revision }, 409);
  await post('/api/rooms/00000000-0000-0000-0000-000000000000', { action: 'snapshot' }, undefined, 404);
  await post(path, { action: 'join', invite: host.invite, name: '   ' }, undefined, 400);
  const guest = await post(path, { action: 'join', invite: host.invite, name: 'Guest' }, undefined, 201);
  state = await beat(guest.token, 1, { duration: 999 });
  assert.equal(state.room.duration, 0, 'only the host reports the duration');
  state = await beat(host.token, 1);
  assert.equal(state.room.duration, 120);
  await call({ action: 'seek', position: 'start', revision: state.room.revision }, 400);
  state = await call({ action: 'play', revision: state.room.revision });
  assert.equal(state.room.playing, true, state.room.reason);
  await call({ action: 'play', revision: state.room.revision }, 409);
  state = await beat(host.token, 2, { duration: 60 });
  assert.equal(state.room.duration, 120, 'the movie cannot shrink under a playing room');
  state = await beat(host.token, 3);
  assert.equal(state.room.duration, 120);
  state = await call({ action: 'seek', position: 120, revision: state.room.revision });
  assert.deepEqual([state.room.position, state.room.epoch, state.room.playing], [120, 1, false]);
  await beat(host.token, 4, { epoch: 1 });
  state = await beat(guest.token, 2, { epoch: 1 });
  state = await call({ action: 'play', revision: state.room.revision });
  assert.deepEqual([state.room.position, state.room.epoch, state.room.playing], [0, 2, false], 'play at the end rewinds instead of starting');
  const { mediaVersion, fileIndex, epoch } = state.room;
  state = await call({ action: 'file', fileIndex, revision: state.room.revision });
  assert.equal(state.room.mediaVersion, mediaVersion, 'reselecting the current video is not a media change');
  await call({ action: 'file', fileIndex: 3.5, revision: state.room.revision }, 400);
  state = await call({ action: 'file', fileIndex: fileIndex + 1, revision: state.room.revision });
  assert.deepEqual([state.room.fileIndex, state.room.mediaVersion, state.room.epoch, state.room.position, state.room.duration, state.room.playing],
    [fileIndex + 1, mediaVersion + 1, epoch + 1, 0, 0, false], 'switching video bumps the media version and restarts buffering');
  await post(path, { action: 'kick', memberId: host.memberId, revision: state.room.revision }, guest.token, 403);
  await call({ action: 'kick', memberId: host.memberId, revision: state.room.revision }, 400);
  state = await call({ action: 'kick', memberId: guest.memberId, revision: state.room.revision });
  assert.equal(state.members.some(member => member.id === guest.memberId), false);
  await post(path, { action: 'snapshot' }, guest.token, 401);
  const readmitted = await post(path, { action: 'join', invite: host.invite, name: 'Guest' }, undefined, 201);
  assert.notEqual(readmitted.memberId, guest.memberId, 'removing someone does not revoke the link they hold, so they come back to a new seat until the host resets it');
  state = await call({ action: 'rotate', revision: state.room.revision });
  assert.match(state.invite, /^[a-f0-9]{64}$/);
  assert.equal(state.room.inviteTag, createHash('sha256').update(state.invite).digest('hex').slice(0, 16), 'the room publishes a tag of the current invite, so a tab still holding the old link can tell it is dead');
  await post(path, { action: 'join', invite: host.invite, name: 'Stale link' }, undefined, 403);
  const rejoined = await post(path, { action: 'join', invite: state.invite, name: 'New link' }, undefined, 201);
  state = await call({ action: 'rotate', revision: state.room.revision });
  await post(path, { action: 'snapshot' }, rejoined.token, 401);
  assert.equal((await call({ action: 'snapshot' })).members.length, 1, 'a new invite link takes the seats the old one handed out');
  for (const route of ['/api/rooms', path, `${path}/helper`, '/api/helper']) {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 405, route);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  for (const hostKey of ['', 'f'.repeat(64), host.hostKey]) {
    await post(path, { action: 'join', invite: state.invite, name: 'Not the host', hostKey }, undefined, 201);
    assert.equal((await call({ action: 'snapshot' })).room.hostId, host.memberId, 'only the real host key moves the room');
  }
  const returning = await post(path, { action: 'join', invite: state.invite, name: 'Host', hostKey: state.hostKey }, undefined, 201);
  assert.equal(returning.memberId, host.memberId, 'the returning host comes back to their own seat');
  assert.equal((await post(path, { action: 'snapshot' }, returning.token)).room.hostId, returning.memberId);
  await post(path, { action: 'snapshot' }, host.token, 401);

  const full = await post('/api/rooms', { source: magnet }, undefined, 201);
  const fullPath = `/api/rooms/${full.roomId}`;
  t.after(() => post(fullPath, { action: 'leave' }, full.token).catch(() => {}));
  const lapsed = await post(fullPath, { action: 'join', invite: full.invite, name: 'Lapsed' }, undefined, 201);
  const away = await post('/api/rooms', { source: magnet }, undefined, 201);
  const awayPath = `/api/rooms/${away.roomId}`;
  t.after(() => post(awayPath, { action: 'leave' }, away.token).catch(() => {}));
  const quiet = await post('/api/rooms', { source: magnet }, undefined, 201);
  const quietPath = `/api/rooms/${quiet.roomId}`;
  t.after(() => post(quietPath, { action: 'leave' }, quiet.token).catch(() => {}));
  const watcher = await post(quietPath, { action: 'join', invite: quiet.invite, name: 'Watcher' }, undefined, 201);
  const beatQuiet = (token, sequence, ready = true, epoch = 0) => post(quietPath, { action: 'heartbeat', ready, buffered: 15, progress: .1, epoch, mediaVersion: 0, duration: 120, sequence }, token);
  await beatQuiet(quiet.token, 1);
  let quietState = await beatQuiet(watcher.token, 1);
  quietState = await post(quietPath, { action: 'play', revision: quietState.room.revision }, quiet.token);
  assert.equal(quietState.room.playing, true, quietState.room.reason);
  await beatQuiet(watcher.token, 2, false);
  const deserted = await post('/api/rooms', { source: magnet }, undefined, 201);
  const desertedPath = `/api/rooms/${deserted.roomId}`;
  t.after(() => post(desertedPath, { action: 'leave' }, deserted.token).catch(() => {}));
  let desertedState = await post(desertedPath, { action: 'heartbeat', ready: true, buffered: 15, epoch: 0, mediaVersion: 0, duration: 120, sequence: 1 }, deserted.token);
  desertedState = await post(desertedPath, { action: 'play', revision: desertedState.room.revision }, deserted.token);
  assert.equal(desertedState.room.playing, true, desertedState.room.reason);
  await new Promise(resolve => setTimeout(resolve, 12500));
  const friend = await post(desertedPath, { action: 'join', invite: deserted.invite, name: 'Friend' }, undefined, 201);
  desertedState = await post(desertedPath, { action: 'snapshot' }, friend.token);
  assert.equal(desertedState.room.playing, false, 'a join stops a room the host has walked out of');
  assert.match(desertedState.room.reason, /host disconnected/, 'the friend is told the host is gone, not that everyone is waiting on them');
  desertedState = await post(desertedPath, { action: 'heartbeat', ready: true, buffered: 15, epoch: 0, mediaVersion: 0, duration: 120, sequence: 2 }, deserted.token);
  assert.match(desertedState.room.reason, /host is back/, 'the couch stops waiting for a host who has returned');
  assert.equal(desertedState.room.playing, false, 'a lease that lapsed is still the host’s to resume');
  for (let i = 0; i < 11; i++) await post(fullPath, { action: 'join', invite: full.invite, name: `Guest ${i}` }, undefined, 201);
  await post(fullPath, { action: 'heartbeat', ready: true, buffered: 15, progress: .1, epoch: 0, mediaVersion: 0, duration: 120, sequence: 1 }, full.token);
  await post(fullPath, { action: 'join', invite: full.invite, name: 'One too many' }, undefined, 409);
  const seat = await post(fullPath, { action: 'heartbeat', ready: true, buffered: 15, progress: .1, epoch: 0, mediaVersion: 0, duration: 0, sequence: 1 }, lapsed.token, 409);
  assert.match(seat.error, /This couch is full \(12 people\)/, 'a lapsed seat cannot be reclaimed while the room is full');
  assert.equal(seat.code, 'seat-lost', 'the refusal names itself, so the client can say the seat is gone rather than that the room is unreachable');
  const back = await post(fullPath, { action: 'join', invite: full.invite, name: 'Host again', hostKey: full.hostKey }, undefined, 201);
  assert.equal(back.memberId, full.memberId, 'a full couch never refuses the host their own seat');
  for (let i = 0; i < 12; i++) await post(awayPath, { action: 'join', invite: away.invite, name: `Seat ${i}` }, undefined, 201);
  const returned = await post(awayPath, { action: 'heartbeat', ready: false, buffered: 0, epoch: 0, mediaVersion: 0, duration: 120, sequence: 1 }, away.token);
  const hostSeat = returned.members.find(member => member.id === away.memberId);
  assert.ok(hostSeat, 'a lapsed host takes their own seat back even after guests have filled every other one');
  assert.equal(hostSeat.epoch, returned.room.epoch, 'a host who comes back still buffering keeps their seat instead of watching from the side');
  quietState = await beatQuiet(quiet.token, 2);
  quietState = await post(quietPath, { action: 'seek', position: 30, revision: quietState.room.revision }, quiet.token);
  quietState = await beatQuiet(quiet.token, 3, true, 1);
  quietState = await post(quietPath, { action: 'play', revision: quietState.room.revision }, quiet.token);
  assert.equal(quietState.room.playing, true, quietState.room.reason);
  quietState = await beatQuiet(watcher.token, 3, true, 0);
  assert.equal(quietState.members.find(m => m.id === watcher.memberId).epoch, -2, 'a lapsed seat comes back as a spectator, however ready it says it is for the scene the room has left');
  assert.equal(quietState.room.playing, true, 'a report from before the seek cannot pause a room the watcher no longer has a seat in');
  quietState = await beatQuiet(watcher.token, 4, false);
  assert.equal(quietState.members.find(m => m.id === watcher.memberId).epoch, -2, 'a spectator that is still buffering stays one');
  assert.equal(quietState.room.playing, true, 'an unready spectator does not hold the room paused');
  quietState = await beatQuiet(watcher.token, 5, true, 1);
  assert.equal(quietState.members.find(m => m.id === watcher.memberId).epoch, 1, 'a spectator takes its seat back by reporting ready at the epoch the room is on');
});

test('a join-then-leave loop cannot outrun the join throttle', { timeout: 60000 }, async t => {
  const host = await post('/api/rooms', { source: magnet }, undefined, 201);
  const path = `/api/rooms/${host.roomId}`;
  t.after(() => post(path, { action: 'leave' }, host.token).catch(() => {}));
  // Leaving frees the seat, so the couch cap never fires and the throttle is the only thing that can stop this. The
  // host's own seat is the first join of the minute, which leaves 23 before the limit.
  for (let i = 0; i < 23; i++) {
    const guest = await post(path, { action: 'join', invite: host.invite, name: `Guest ${i}` }, undefined, 201);
    await post(path, { action: 'leave' }, guest.token);
  }
  const refused = await post(path, { action: 'join', invite: host.invite, name: 'One too many' }, undefined, 429);
  assert.match(refused.error, /Too many joins/, 'a join counts against the throttle however it ended');
});
