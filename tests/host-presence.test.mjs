import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESENCE_MS } from '../helper/constants.mjs';
const origin = process.env.TEST_ORIGIN || 'http://localhost:3001';
const send = async (path, body, token, expected = body.source || body.action === 'join' ? 201 : 200) => {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    .catch(error => { throw new Error(`POST ${origin + path}: ${error.message}`); });
  const data = await response.json();
  assert.equal(response.status, expected, data.error);
  return data;
};

test('an expired host lease cannot silently restart a deserted playing room', { timeout: 30000 }, async t => {
  const host = await send('/api/rooms', { source: 'magnet:?xt=urn:btih:' + 'b'.repeat(40) });
  const path = `/api/rooms/${host.roomId}`;
  t.after(() => send(path, { action: 'leave' }, host.token).catch(() => {}));
  const report = { action: 'heartbeat', ready: true, buffered: 90, progress: 1, duration: 120, epoch: 0, mediaVersion: 0, sequence: 1 };
  let state = await send(path, report, host.token);
  state = await send(path, { action: 'play', revision: state.room.revision }, host.token);
  assert.equal(state.room.playing, true);
  // The room must stop where the host's lease lapsed, not where this request arrived.
  const expected = (state.members.find(member => member.id === host.memberId).lastSeen + PRESENCE_MS - state.room.startsAt) / 1000;
  await new Promise(resolve => setTimeout(resolve, PRESENCE_MS + 500));
  state = await send(path, { ...report, sequence: 2 }, host.token);
  assert.equal(state.room.playing, false);
  assert.match(state.room.reason, /host disconnected/);
  assert.ok(Math.abs(state.room.position - expected) < 0.01, `the room stops at the host's lease expiry, not at this request (${state.room.position}, expected ${expected})`);
  await send(path, { action: 'leave' }, host.token);
});

// A buffering pause restarts itself once everyone is ready, and a host who walked out of one must not come back to
// a movie already starting: their lapsed lease is theirs to resume, as it is when they walk out of a playing room.
test('a host who walks out of a buffering pause is not started without on their return', { timeout: 40000 }, async t => {
  const host = await send('/api/rooms', { source: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) });
  const path = `/api/rooms/${host.roomId}`;
  t.after(() => send(path, { action: 'leave' }, host.token).catch(() => {}));
  const guest = await send(path, { action: 'join', invite: host.invite, name: 'Guest' });
  const report = (sequence, ready = true) => ({ action: 'heartbeat', ready, buffered: 90, progress: 1, duration: 120, epoch: 0, mediaVersion: 0, sequence });
  await send(path, report(1), guest.token);
  let state = await send(path, report(1), host.token);
  state = await send(path, { action: 'play', revision: state.room.revision }, host.token);
  assert.equal(state.room.playing, true);
  state = await send(path, report(2, false), guest.token);
  assert.match(state.room.reason, /buffering/, 'the stalled guest pauses the room');
  // The host goes quiet past their lease while the guest, still stalled, keeps its seat; then the guest catches up.
  for (let sequence = 3; sequence < 8; sequence++) {
    await new Promise(resolve => setTimeout(resolve, 2700));
    state = await send(path, report(sequence, false), guest.token);
  }
  assert.equal(state.room.playing, false);
  assert.match(state.room.reason, /host disconnected/, 'the pause now waits on the host, not on a buffer');
  state = await send(path, report(8), guest.token);
  assert.equal(state.room.playing, false);
  state = await send(path, report(2), host.token);
  assert.equal(state.room.playing, false, 'the room restarted itself the moment the host came back');
  assert.match(state.room.reason, /host is back/);
});
