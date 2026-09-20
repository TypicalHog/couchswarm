import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebTorrent from 'webtorrent';
import MemoryStore from 'memory-chunk-store';
import Peer from '@thaunknown/simple-peer';
process.env.COUCHSWARM_HELPER_OFFLINE = '1';
const packaged = process.env.COUCHSWARM_PACKAGED_TEST === '1';
// build-helper copies helper/*.mjs verbatim, so byte equality is the freshness test; a stale package
// otherwise reports the source suite's failures as code regressions.
if (packaged) {
  const stale = [];
  // Read from helper/ rather than listed here, so a module the helper starts importing cannot be left out of a
  // package: server.mjs is the standalone dev helper and belongs to neither, and launcher.mjs is the Linux front
  // end, which has as little place in the Windows package as the GUI has in the Linux one.
  const sources = (await readdir(new URL('../helper', import.meta.url))).filter(file => file.endsWith('.mjs') && file !== 'server.mjs');
  for (const [stage, archive, native] of [['helper-package', 'CouchSwarm-Helper-win-x64.zip', 'MZ'], ['helper-package-linux', 'CouchSwarm-Helper-linux-x64.tar.gz', '\x7fELF']]) {
    const app = new URL(`../work/${stage}/app/`, import.meta.url);
    for (const file of sources.filter(file => stage.endsWith('linux') || file !== 'launcher.mjs'))
      if (await readFile(new URL(`helper/${file}`, app), 'utf8').catch(() => null)
        !== await readFile(new URL(`../helper/${file}`, import.meta.url), 'utf8')) stale.push(`${stage}/${file}`);
    // Byte equality only covers those scripts: a build that failed after copying them leaves a stage whose imports
    // resolve from the repo's own node_modules, beside an archive that is not the file people download.
    for (const name of ['webtorrent', '@thaunknown/simple-peer', 'bittorrent-protocol', 'ut_metadata', 'parse-torrent', 'range-parser'])
      if (!await stat(new URL(`node_modules/${name}/package.json`, app)).catch(() => null)) stale.push(`${stage}/${name}`);
    // node-datachannel ships no prebuilds directory, so the build has to put the target's binding there itself.
    // The Linux package is cross-built on a machine that cannot run it, and a binding for the wrong platform then
    // has nothing to give it away but its own file header.
    const binding = await readFile(new URL('node_modules/node-datachannel/build/Release/node_datachannel.node', app)).catch(() => null);
    if (binding?.toString('latin1', 0, native.length) !== native) stale.push(`${stage}/node_datachannel.node`);
    const built = await stat(new URL(`../public/downloads/${archive}`, import.meta.url)).catch(() => null);
    const copied = await stat(new URL('helper/remote-agent.mjs', app)).catch(() => null);
    if (!built || !copied || built.mtimeMs < copied.mtimeMs) stale.push(archive);
  }
  if (stale.length) throw new Error(`The packaged helper is missing or stale (${stale.join(', ')}). Run npm run build:helper and npm run build:helper:linux.`);
}
const { createRemoteAgent, nativeIceServers } = await import(packaged ? '../work/helper-package/app/helper/remote-agent.mjs' : '../helper/remote-agent.mjs');

const origin = process.env.TEST_ORIGIN || 'http://localhost:3001';
const offline = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false };
const destroy = client => new Promise(resolve => client.destroy(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = promisify(execFile);
async function post(route, body, token, expected = 200) {
  const response = await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    .catch(error => { throw new Error(`POST ${origin + route}: ${error.message}`); });
  const data = await response.json();
  assert.equal(response.status, expected, data.error || JSON.stringify(data));
  return data;
}
test('helper pairing is per participant, single-use, scoped, revocable, and rejects stale signaling', { timeout: 30000 }, async t => {
  const host = await post('/api/rooms', { source: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const guest = await post(room, { action: 'join', invite: host.invite, name: 'Guest' }, null, 201);
  t.after(() => post(room, { action: 'leave' }, guest.token).catch(() => {}));
  await post(route, { action: 'status' }, null, 403);
  const claim = async (pairingUrl, version) => post('/api/helper', { action: 'claim', code: new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get('helper'), version });
  const pair = await post(route, { action: 'pair' }, host.token);
  const grant = await claim(pair.pairingUrl);
  // A helper that names no build predates version reporting and must never be nagged.
  assert.equal(grant.siteVersion, '', 'a helper that reports no build is left alone');
  await post('/api/helper', { action: 'claim', code: new URLSearchParams(new URL(pair.pairingUrl).hash.slice(1)).get('helper') }, null, 410);
  await post('/api/helper', { action: 'poll', id: grant.id }, host.token, 403);
  await post(room, { action: 'pause', revision: 0 }, grant.token, 401);
  const ready = (id, token) => post('/api/helper', { action: 'poll', id, mediaVersion: 0, infoHash: 'a'.repeat(40), status: 'Ready' }, token);
  const ice = ({ iceServers, relayAvailable }) => {
    assert.ok(iceServers.every(server => Array.isArray(server.urls) && server.urls.every(url => /^(stun|turn)s?:/.test(url))), 'every ICE entry is a usable STUN or TURN URL');
    const turn = iceServers.filter(server => server.urls.some(url => /^turns?:/.test(url)));
    assert.equal(relayAvailable, turn.length > 0, 'relayAvailable tracks a real TURN entry');
    assert.ok(turn.every(server => /^\d+:.+/.test(server.username || '') && typeof server.credential === 'string' && server.credential.length > 0), 'a TURN entry carries REST credentials');
  };
  ice(await ready(grant.id, grant.token));
  // Guests stream from the host's helper until they run their own.
  let state = await post(route, { action: 'status' }, guest.token);
  assert.deepEqual([state.ready, state.own, state.mine], [true, false, false]);
  ice(state);
  // A signal must carry a data-channel media section and nothing else, so every fixture below has one.
  const sdp = name => `${name}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
  const offer = { type: 'offer', sdp: sdp('test offer') };
  await post(route, { action: 'offer', mediaVersion: 1, offer }, guest.token, 409);
  assert.match((await post(route, { action: 'offer', mediaVersion: 0, offer: { type: 'offer', sdp: '' } }, guest.token, 409)).error, /stale or invalid/);
  const connection = await post(route, { action: 'offer', mediaVersion: 0, offer }, guest.token, 201);
  await post(route, { action: 'peer', peerId: connection.peerId }, host.token, 410);
  await post('/api/helper', { action: 'answer', id: grant.id, peerId: connection.peerId, answer: { type: 'answer', sdp: sdp('test answer') } }, grant.token);
  await post('/api/helper', { action: 'answer', id: grant.id, peerId: connection.peerId, answer: { type: 'answer', sdp: sdp('second answer') } }, grant.token, 410);
  assert.equal((await post(route, { action: 'peer', peerId: connection.peerId }, guest.token)).answer.sdp, sdp('test answer'));
  // A guest's own helper takes over once it is ready. Until then the host's ready helper keeps serving them.
  const guestGrant = await claim((await post(route, { action: 'pair' }, guest.token)).pairingUrl, '0.0.1');
  assert.match(guestGrant.siteVersion, /^\d+\.\d+/, 'a helper behind the site is told which build it ships');
  state = await post(route, { action: 'status' }, guest.token);
  assert.deepEqual([state.paired, state.online, state.ready, state.own, state.mine], [true, true, true, false, true]);
  assert.equal((await post(route, { action: 'peer', peerId: connection.peerId }, guest.token)).answer.sdp, sdp('test answer'));
  const replaced = await post(route, { action: 'offer', mediaVersion: 0, offer }, guest.token, 201);
  await post(route, { action: 'close', peerId: replaced.peerId }, guest.token);
  await post(route, { action: 'peer', peerId: replaced.peerId }, guest.token, 410);
  await ready(guestGrant.id, guestGrant.token);
  state = await post(route, { action: 'status' }, guest.token);
  assert.deepEqual([state.ready, state.own], [true, true]);
  const own = await post(route, { action: 'offer', mediaVersion: 0, offer }, guest.token, 201);
  assert.deepEqual((await ready(guestGrant.id, guestGrant.token)).peers.map(peer => peer.id), [own.peerId]);
  assert.deepEqual((await ready(grant.id, grant.token)).peers, []);
  assert.equal((await post(route, { action: 'status' }, host.token)).own, true);
  // Stopping the guest's helper drops its pairing and falls back to the host's helper.
  await post('/api/helper', { action: 'stop', id: guestGrant.id }, guestGrant.token);
  state = await post(route, { action: 'status' }, guest.token);
  assert.deepEqual([state.ready, state.own, state.mine], [true, false, false]);
  await post(route, { action: 'peer', peerId: own.peerId }, guest.token, 410);
  // Unpairing only removes the caller's helper.
  await post(route, { action: 'unpair' }, guest.token);
  await post('/api/helper', { action: 'poll', id: guestGrant.id }, guestGrant.token, 403);
  state = await post(route, { action: 'status' }, guest.token);
  assert.deepEqual([state.paired, state.mine], [true, false]);
  await post(route, { action: 'unpair' }, host.token);
  await post('/api/helper', { action: 'poll', id: grant.id }, grant.token, 403);
  assert.equal((await post(route, { action: 'status' }, guest.token)).paired, false);
});

test('remote helper delivers magnet metadata and seekable multi-file bytes from TCP over authenticated WebRTC', { timeout: 45000 }, async t => {
  const seed = new WebTorrent(offline), viewer = new WebTorrent(offline);
  t.after(() => destroy(seed)); t.after(() => destroy(viewer));
  const first = Object.assign(Buffer.alloc(16383, 19), { name: 'a.mp4' });
  const second = Object.assign(Buffer.from(Array.from({ length: 98305 }, (_, i) => i % 251)), { name: 'b.mkv' });
  const seeded = await new Promise(resolve => seed.seed([first, second], { name: 'RTC fixture', pieceLength: 16384, announce: [], store: MemoryStore }, resolve));
  const source = `${seeded.magnetURI}&x.pe=127.0.0.1:${seed.torrentPort}`;
  // Start with an unavailable torrent to exercise cancellation of metadata loading.
  const host = await post('/api/rooms', { source: 'magnet:?xt=urn:btih:' + 'b'.repeat(40) }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-rtc-test-'));
  let nativeClient;
  const reports = [];
  // A two-piece read-ahead window against the 7-piece fixture, so the slide and edge branches actually run.
  const helper = createRemoteAgent({ cacheRoot, pollMs: 100, iceOverride: [], readAheadBytes: 32768, report: value => reports.push(value), createClient: () => nativeClient = new WebTorrent(offline) });
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  const loading = () => reports.some(value => value.status === 'Finding torrent peers…');
  for (let i = 0; i < 200 && !loading(); i++) await sleep(50);
  assert.ok(loading(), 'the agent started loading the unavailable magnet');
  await post(room, { action: 'source', source, revision: 0 }, host.token);
  let state;
  for (let i = 0; i < 100; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'source switch cancels unavailable metadata immediately');
  assert.equal(state.infoHash, seeded.infoHash);
  // markSparse flags every span file larger than a piece before the first write; a.mp4 (<= pieceLength) is skipped.
  if (process.platform === 'win32') {
    const [dir] = (await readdir(cacheRoot)).filter(name => name.startsWith('room-'));
    // fsutil exits 0 either way and prints its verdict in the UI language, so the only reading that holds on a
    // non-English Windows is against a file that is certainly not sparse.
    const queryflag = async file => (await run('fsutil', ['sparse', 'queryflag', file], { windowsHide: true })).stdout.trim();
    const control = `${cacheRoot}-control.bin`;
    await writeFile(control, '');
    try {
      assert.notEqual(await queryflag(path.join(cacheRoot, dir, 'RTC fixture', 'b.mkv')), await queryflag(control),
        'the helper marked the movie file sparse before writing it');
    } finally { await rm(control, { force: true }); }
  }
  const peer = new Peer({ initiator: true, trickle: false, config: { iceServers: [] } });
  peer.on('error', () => {}); peer.id = 'test-room-peer';
  t.after(() => peer.destroy());
  const connected = once(peer, 'connect');
  const [offer] = await once(peer, 'signal');
  const asked = Date.now();
  let answered = 0;
  const { peerId } = await post(route, { action: 'offer', mediaVersion: 1, offer }, host.token, 201);
  for (let i = 0; i < 100; i++) {
    const response = await post(route, { action: 'peer', peerId }, host.token);
    if (response.answer) { answered = Date.now(); peer.signal(response.answer); break; }
    await sleep(100);
  }
  // Without the agent's gathering-complete bridge simple-peer sits on the answer for its full 5 s fallback timer.
  assert.ok(answered - asked < 2000, `the helper answers as soon as it has gathered (${answered - asked} ms)`);
  await connected;
  const received = viewer.add(state.infoHash, { announce: [], store: MemoryStore, deselect: true, strategy: 'sequential' });
  const ready = once(received, 'ready');
  received.on('error', () => {});
  if (!received.infoHash) await once(received, 'infoHash');
  assert.equal(received.metadata, null, 'metadata has not arrived through any other source');
  received.addPeer(peer);
  await ready;
  assert.equal(received.files.length, 2);
  assert.equal(received.pieces.length, 7, 'a piece count that is not a multiple of 8 exercises the trailing bitfield mask');
  assert.equal(received.wires[0].peerPieces.get(6), true);
  assert.equal(received.wires[0].peerPieces.get(7), false, 'the helper advertises no piece it does not have');
  async function bytes(file, start, end) {
    const chunks = [];
    for await (const chunk of file.createReadStream({ start, end })) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const movie = received.files.find(file => file.name === 'b.mkv');
  assert.deepEqual(await bytes(movie, second.length - 4096, second.length - 1), second.subarray(-4096), 'seek directly to the tail');
  assert.ok(received.downloaded < seeded.length, 'the helper does not download the whole torrent before a seek');
  const native = nativeClient.torrents[0];
  assert.ok(native.downloaded < seeded.length / 2, `the helper fetched only the pieces the viewer asked for (${native.downloaded} of ${seeded.length})`);
  // These two repeats are sequential; the simultaneous case is a unit test in tests/remote-wire.test.mjs.
  const block = () => new Promise((resolve, reject) => received.wires[0].request(6, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const twins = await Promise.all([block(), block()]);
  assert.deepEqual(twins, [second.subarray(81921, 98305), second.subarray(81921, 98305)], 'both copies of a repeated block request are answered');
  assert.deepEqual(await bytes(movie, 0, 32767), second.subarray(0, 32768), 'cross-file piece with exactly one byte in the second file');
  for (let i = 0; i < 100 && !native.bitfield.get(4); i++) await sleep(50);
  assert.ok(native.bitfield.get(3) && native.bitfield.get(4), 'a request past the first half of its window slides the window forward');
  assert.equal(native.bitfield.get(5), false, 'read-ahead stops at the window edge instead of selecting the whole torrent');
  assert.deepEqual(await bytes(received.files.find(file => file.name === 'a.mp4'), 0, first.length - 1), Buffer.from(first));
  assert.ok(peer.connected, 'the peer is still connected when the helper is stopped');
  const closed = new Promise(resolve => { peer.once('close', resolve); peer.once('disconnect', resolve); });
  // Destroying the native torrent tears the agent down early, draining the stop() assertions below,
  // so that case runs against its own room and agent.
  assert.notEqual((await readdir(cacheRoot)).length, 0, 'the helper reaches stop() holding a torrent and a populated cache');
  t.diagnostic('Verified metadata, tail seek, and cross-file bytes; stopping helper.');
  await helper.stop();
  t.diagnostic('Helper stopped; verifying connection and cache cleanup.');
  await closed;
  assert.deepEqual(await readdir(cacheRoot), []);
  assert.equal((await post(route, { action: 'status' }, host.token)).online, false);
});

// Nothing else drives the encoding at remote-agent.mjs: every other agent test passes an empty iceOverride, and
// scripts/check-relay.mjs keeps its own copy and needs a live relay. This one answers one 401 challenge from a UDP
// socket and reads what the real ICE stack puts on the wire, so removing the encoding — or webrtc-polyfill starting
// to do it itself — fails here.
test('the helper hands the native ICE stack TURN credentials it can put on the wire', { timeout: 15000 }, async t => {
  const realm = 'couchswarm.test', nonce = 'a1b2c3';
  // A TURN REST username carries a colon, and a base64 credential the three characters a URL cannot hold.
  const username = '1789613200:member-1', credential = 'z+9/Ab=';
  const attributes = message => {
    const found = [];
    for (let at = 20; at + 4 <= message.length;) {
      const length = message.readUInt16BE(at + 2);
      found.push({ type: message.readUInt16BE(at), at, value: message.subarray(at + 4, at + 4 + length) });
      at += 4 + length + (-length & 3);
    }
    return found;
  };
  const attribute = (type, value) => {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(type, 0); header.writeUInt16BE(value.length, 2);
    return Buffer.concat([header, value, Buffer.alloc(-value.length & 3)]);
  };
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});
  t.after(() => socket.close());
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const allocate = new Promise(resolve => socket.on('message', (data, from) => {
    const found = attributes(data);
    const user = found.find(value => value.type === 0x0006), integrity = found.find(value => value.type === 0x0008);
    if (!user || !integrity) {
      // The first Allocate carries no credentials; the 401 is what asks for them.
      const body = Buffer.concat([attribute(0x0009, Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')])),
        attribute(0x0014, Buffer.from(realm)), attribute(0x0015, Buffer.from(nonce))]);
      const header = Buffer.alloc(20);
      header.writeUInt16BE(0x0113, 0); header.writeUInt16BE(body.length, 2); header.writeUInt32BE(0x2112a442, 4);
      data.copy(header, 8, 8, 20);
      socket.send(Buffer.concat([header, body]), from.port, from.address);
      return;
    }
    // MESSAGE-INTEGRITY covers the message up to itself, with the length field counting its own 24 bytes.
    const signed = Buffer.from(data.subarray(0, integrity.at));
    signed.writeUInt16BE(integrity.at - 20 + 24, 2);
    const key = createHash('md5').update(`${user.value.toString()}:${realm}:${credential}`).digest();
    resolve({ username: user.value.toString(), verified: createHmac('sha1', key).update(signed).digest().equals(integrity.value) });
  }));
  const peer = new Peer({ initiator: true, trickle: false, config: { iceTransportPolicy: 'relay',
    iceServers: nativeIceServers([{ urls: [`turn:127.0.0.1:${socket.address().port}?transport=udp`], username, credential }]) } });
  peer.on('error', () => {});
  t.after(() => peer.destroy());
  const authenticated = await allocate;
  assert.equal(authenticated.username, username, 'the whole TURN REST username reaches the relay, colon and all');
  assert.ok(authenticated.verified, 'the relay can verify the credential against the one the room issued');
});

test('a failed native torrent stops advertising readiness, then reloads', { timeout: 60000 }, async t => {
  const seed = new WebTorrent(offline);
  t.after(() => destroy(seed));
  const payload = Object.assign(Buffer.alloc(16384, 23), { name: 'movie.mp4' });
  const seeded = await new Promise(resolve => seed.seed(payload, { name: payload.name, pieceLength: 16384, announce: [], store: MemoryStore }, resolve));
  const host = await post('/api/rooms', { source: `${seeded.magnetURI}&x.pe=127.0.0.1:${seed.torrentPort}` }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-failed-test-'));
  let nativeClient;
  const reports = [];
  const helper = createRemoteAgent({ cacheRoot, pollMs: 100, retryMs: 2000, iceOverride: [], report: value => reports.push(value), createClient: () => nativeClient = new WebTorrent(offline) });
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  let state;
  for (let i = 0; i < 200; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'the helper loaded the seeded torrent');
  // Picking another file bumps the media version without changing the source, so the helper keeps the torrent it
  // already loaded and the load that created it is aborted. A failure after that must still be noticed.
  await post(room, { action: 'file', fileIndex: 1, revision: 0 }, host.token);
  for (let i = 0; i < 100; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'the helper serves the same torrent across a file switch');
  await new Promise(resolve => nativeClient.torrents[0].destroy(resolve));
  for (let i = 0; i < 30; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (!state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, false, 'a failed native torrent cannot keep advertising readiness');
  assert.ok(reports.some(value => /The torrent connection failed\. Reconnecting/.test(value.status)), 'the failure names its cause and promises a reload');
  // The reload is scheduled retryMs after the failure — 2 seconds here, 15 in the shipped default.
  for (let i = 0; i < 300 && !state.ready; i++) {
    await sleep(100);
    state = await post(route, { action: 'status' }, host.token);
  }
  assert.equal(state.ready, true, 'the helper reloads a torrent that failed after serving');
  assert.equal(state.infoHash, seeded.infoHash);
});

test('picking another video does not restart a load already under way', { timeout: 20000 }, async t => {
  const host = await post('/api/rooms', { source: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-pick-test-'));
  const reports = [];
  let clients = 0;
  const helper = createRemoteAgent({ cacheRoot, pollMs: 100, iceOverride: [], report: value => reports.push(value),
    createClient: () => { clients++; return new WebTorrent(offline); } });
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  // The magnet has no seeders, so the load stays where a metadata fetch or a hash check would leave it.
  for (let i = 0; i < 100 && clients === 0; i++) await sleep(50);
  assert.equal(clients, 1, 'the helper started loading the magnet');
  await post(room, { action: 'file', fileIndex: 1, revision: 0 }, host.token);
  await sleep(1000);
  assert.equal(clients, 1, 'a file pick keeps the client that is already fetching this torrent');
  assert.equal(reports.at(-1).status, 'Finding torrent peers…', 'the helper is still on the load it started');
});

test('a kept download gets its own subfolder, outlives the helper, and reloads without the swarm', { timeout: 30000 }, async t => {
  const seed = new WebTorrent(offline);
  t.after(() => destroy(seed));
  const payload = Object.assign(Buffer.alloc(16384, 29), { name: 'movie.mp4' });
  const seeded = await new Promise(resolve => seed.seed(payload, { name: payload.name, pieceLength: 16384, announce: [], store: MemoryStore }, resolve));
  const host = await post('/api/rooms', { source: `${seeded.magnetURI}&x.pe=127.0.0.1:${seed.torrentPort}` }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-keep-test-'));
  const helper = createRemoteAgent({ cacheRoot, keepDownloads: true, pollMs: 100, iceOverride: [], createClient: () => new WebTorrent(offline) });
  // Two clients wrote into this folder, and Windows releases their handles a moment after the destroy returns.
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await helper.pair(pair.pairingUrl);
  let state;
  for (let i = 0; i < 200; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'the helper loaded the seeded torrent into the folder the user chose');
  const kept = [`torrent-${seeded.infoHash}`, `torrent-${seeded.infoHash}.torrent`];
  assert.deepEqual((await readdir(cacheRoot)).sort(), kept, 'a torrent the user keeps gets its own folder, with only the saved info dict beside it');
  await helper.stop();
  assert.deepEqual((await readdir(cacheRoot)).sort(), kept, 'stopping the helper leaves a kept download where the user can find it');
  // The swarm is gone and the second room's magnet carries no peer hint, so nothing can hand this helper the
  // metadata: reaching 'ready' at all means the saved info dict was read back off the disk.
  await new Promise(resolve => seed.torrents[0].destroy(resolve));
  const again = await post('/api/rooms', { source: seeded.magnetURI }, null, 201);
  const againRoom = `/api/rooms/${again.roomId}`, againRoute = againRoom + '/helper';
  t.after(() => post(againRoom, { action: 'leave' }, again.token).catch(() => {}));
  const reloaded = createRemoteAgent({ cacheRoot, keepDownloads: true, pollMs: 100, iceOverride: [], createClient: () => new WebTorrent(offline) });
  t.after(() => reloaded.stop());
  await reloaded.pair((await post(againRoute, { action: 'pair' }, again.token)).pairingUrl);
  for (let i = 0; i < 100; i++) {
    state = await post(againRoute, { action: 'status' }, again.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'a kept download is served again when no peer is left to send the metadata');
  await reloaded.stop();
});

test('a torrent is refused before its folders reach the disk', { timeout: 30000 }, async t => {
  const seed = new WebTorrent(offline);
  t.after(() => destroy(seed));
  // 'aux' lies past the video span, so only screening every file catches it, and the hash check would have made it
  // before the old post-ready check ran.
  const payload = [Object.assign(Buffer.alloc(16384, 31), { name: 'Fixture/movie.mp4' }),
    Object.assign(Buffer.alloc(100, 7), { name: 'Fixture/aux/extra.txt' })];
  const seeded = await new Promise(resolve => seed.seed(payload, { name: 'Fixture', pieceLength: 16384, announce: [], store: MemoryStore }, resolve));
  const host = await post('/api/rooms', { source: `${seeded.magnetURI}&x.pe=127.0.0.1:${seed.torrentPort}` }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-folder-test-'));
  const reports = [];
  const helper = createRemoteAgent({ cacheRoot, keepDownloads: true, pollMs: 100, iceOverride: [], report: value => reports.push(value),
    createClient: () => new WebTorrent(offline) });
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  for (let i = 0; i < 200 && !reports.some(value => /folder name Windows cannot create/.test(value.status)); i++) await sleep(100);
  assert.ok(reports.some(value => /folder name Windows cannot create/.test(value.status)), reports.at(-1)?.status);
  assert.deepEqual(await readdir(path.join(cacheRoot, `torrent-${seeded.infoHash}`)), [],
    'the torrent is judged before anything opens a file, so no folder Windows cannot remove is left behind');
});

test('an answered offer is not a connected viewer', { timeout: 30000 }, async t => {
  const seed = new WebTorrent(offline);
  t.after(() => destroy(seed));
  const payload = Object.assign(Buffer.alloc(16384, 41), { name: 'movie.mp4' });
  const seeded = await new Promise(resolve => seed.seed(payload, { name: payload.name, pieceLength: 16384, announce: [], store: MemoryStore }, resolve));
  const host = await post('/api/rooms', { source: `${seeded.magnetURI}&x.pe=127.0.0.1:${seed.torrentPort}` }, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-count-test-'));
  const reports = [];
  const helper = createRemoteAgent({ cacheRoot, pollMs: 100, iceOverride: [], report: value => reports.push(value), createClient: () => new WebTorrent(offline) });
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  let state;
  for (let i = 0; i < 200; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'the helper loaded the seeded torrent');
  // roomAccess does not renew a seat, and the wait above can outlast the presence window.
  await post(room, { action: 'heartbeat', ready: true, buffered: 15, epoch: 0, mediaVersion: 0, duration: 120, sequence: 1 }, host.token);
  const peer = new Peer({ initiator: true, trickle: false, config: { iceServers: [] } });
  peer.on('error', () => {});
  t.after(() => peer.destroy());
  const [offer] = await once(peer, 'signal');
  const { peerId } = await post(route, { action: 'offer', mediaVersion: 0, offer }, host.token, 201);
  let answered = false;
  for (let i = 0; i < 100 && !answered; i++) {
    answered = !!(await post(route, { action: 'peer', peerId }, host.token)).answer;
    if (!answered) await sleep(100);
  }
  assert.ok(answered, 'the helper answered the offer and now holds a peer that cannot connect');
  // The answer is never signalled back, so this viewer stays a friend behind a NAT the helper cannot reach.
  const before = reports.length;
  await sleep(600);
  assert.ok(reports.length > before, 'the helper kept reporting while the offer sat unconnected');
  assert.ok(reports.slice(before).every(value => !value.peers), 'the launcher is not told about a viewer that never connected');
});

// CS1-S41: a revoked pairing must stop the agent from its own poll, so this case needs its own
// helper — an unpaired room reports online === false whether or not the agent ever said goodbye.
test('a revoked pairing stops the helper from its own poll', { timeout: 20000 }, async t => {
  const host = await post('/api/rooms', {}, null, 201);
  const room = `/api/rooms/${host.roomId}`, route = room + '/helper';
  t.after(() => post(room, { action: 'leave' }, host.token).catch(() => {}));
  const pair = await post(route, { action: 'pair' }, host.token);
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-revoke-test-'));
  const reports = [];
  const helper = createRemoteAgent({ cacheRoot, pollMs: 100, iceOverride: [], report: value => reports.push(value) });
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  await post(route, { action: 'unpair' }, host.token);
  for (let i = 0; i < 100 && !reports.some(value => value.stopped); i++) await sleep(100);
  assert.ok(reports.some(value => value.stopped), 'the helper stops itself once the room revokes it');
});
