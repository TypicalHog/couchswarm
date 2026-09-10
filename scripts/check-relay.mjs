import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import Peer from '@thaunknown/simple-peer';

const urls = (process.env.COUCHSWARM_TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
const secret = process.env.COUCHSWARM_TURN_SECRET;
if (!urls.length || !secret) throw new Error('Set COUCHSWARM_TURN_URLS and COUCHSWARM_TURN_SECRET for the running relay.');
for (const url of urls) {
  const username = `${Math.floor(Date.now() / 1000) + 300}:couchswarm-check`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  const config = { iceTransportPolicy: 'relay', iceServers: [{ urls: url, username: encodeURIComponent(username), credential: encodeURIComponent(credential) }] };
  const sender = new Peer({ initiator: true, trickle: false, config });
  const receiver = new Peer({ initiator: false, trickle: false, config });
  const payload = randomBytes(16384);
  sender.on('error', () => {}); receiver.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Relay-only connection timed out: ${url}`)), 45000);
      const fail = error => { clearTimeout(timeout); reject(error); };
      sender.once('error', fail); receiver.once('error', fail);
      sender.on('signal', data => receiver.signal(data)); receiver.on('signal', data => sender.signal(data));
      sender.once('connect', () => sender.send(payload));
      receiver.once('data', bytes => { clearTimeout(timeout); try { assert.ok(Buffer.from(bytes).equals(payload)); resolve(); } catch (error) { reject(error); } });
    });
    for (const peer of [sender, receiver]) {
      const stats = await new Promise((resolve, reject) => peer.getStats((error, values) => error ? reject(error) : resolve(values)));
      const transport = stats.find(value => value.type === 'transport');
      const pair = stats.find(value => value.id === transport?.selectedCandidatePairId);
      const candidate = stats.find(value => value.id === pair?.localCandidateId);
      assert.equal(candidate?.candidateType, 'relay', 'Data must use an actual relay candidate.');
    }
    console.log(`PASS: relay-only transfer and both selected relay candidates (${url})`);
  } finally { sender.destroy(); receiver.destroy(); }
}
