import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { iceConfiguration } from '../lib/ice.ts';

const urls = ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp'];
const secret = 'a-coturn-static-auth-secret';

test('a configured relay issues an hour-aligned coturn REST credential', async t => {
  t.after(() => { delete process.env.COUCHSWARM_TURN_URLS; delete process.env.COUCHSWARM_TURN_SECRET; });
  process.env.COUCHSWARM_TURN_URLS = urls.join(',');
  process.env.COUCHSWARM_TURN_SECRET = secret;
  const { iceServers, relayAvailable } = await iceConfiguration('member-1');
  assert.equal(iceServers.length, 2);
  assert.deepEqual(iceServers[1].urls, urls);
  const username = iceServers[1].username!;
  assert.match(username, /^\d+:member-1$/);
  const expires = Number(username.split(':')[0]);
  assert.equal(expires % 3600, 0, 'the expiry is aligned to the hour so a credential is reusable within it');
  assert.ok(expires * 1000 - Date.now() > 86400000 && expires * 1000 - Date.now() <= 90000000, 'the credential outlives a 24 h room');
  assert.equal(iceServers[1].credential, createHmac('sha1', secret).update(username).digest('base64'));
  assert.equal(relayAvailable, true);
});

// Relay URLs without a secret, set here rather than inherited from the test above, so the case still holds when
// this test runs alone with a developer's COUCHSWARM_TURN_* exported for npm run test:relay.
test('without a relay secret only STUN is offered', async t => {
  t.after(() => { delete process.env.COUCHSWARM_TURN_URLS; delete process.env.COUCHSWARM_TURN_SECRET; });
  process.env.COUCHSWARM_TURN_URLS = urls.join(',');
  delete process.env.COUCHSWARM_TURN_SECRET;
  const { iceServers, relayAvailable } = await iceConfiguration('member-1');
  assert.equal(iceServers.length, 1);
  assert.equal(relayAvailable, false);
});

test('the TURN and STUN lists are trimmed and filtered', async t => {
  t.after(() => { delete process.env.COUCHSWARM_TURN_URLS; delete process.env.COUCHSWARM_TURN_SECRET; delete process.env.COUCHSWARM_STUN_URLS; });
  process.env.COUCHSWARM_TURN_URLS = ' turn:a.example:3478 ,, stun:x.example ,turns:b.example:443?transport=tcp';
  process.env.COUCHSWARM_TURN_SECRET = secret;
  process.env.COUCHSWARM_STUN_URLS = ' stun:s.example:3478 ';
  const { iceServers } = await iceConfiguration('member-1');
  assert.deepEqual(iceServers[0].urls, ['stun:s.example:3478'], 'a padded entry is trimmed rather than dropped');
  assert.deepEqual(iceServers[1].urls, ['turn:a.example:3478', 'turns:b.example:443?transport=tcp']);
});
