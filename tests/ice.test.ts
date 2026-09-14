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

test('without a relay secret only STUN is offered', async () => {
  const { iceServers, relayAvailable } = await iceConfiguration('member-1');
  assert.equal(iceServers.length, 1);
  assert.equal(relayAvailable, false);
});
