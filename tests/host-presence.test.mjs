import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESENCE_MS } from '../helper/constants.mjs';
const origin = process.env.TEST_ORIGIN || 'http://localhost:3001';

test('an expired host lease cannot silently restart a deserted playing room', { timeout: 30000 }, async t => {
  const send = async (path, body, token) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      .catch(error => { throw new Error(`POST ${origin + path}: ${error.message}`); });
    const data = await response.json();
    assert.equal(response.status, body.source ? 201 : 200, data.error);
    return data;
  };
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
