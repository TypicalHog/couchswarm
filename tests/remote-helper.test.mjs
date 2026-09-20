import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import WebTorrent from 'webtorrent';
import MemoryStore from 'memory-chunk-store';
import Peer from '@thaunknown/simple-peer';
import Wire from 'bittorrent-protocol';
process.env.COUCHSWARM_HELPER_OFFLINE = '1';
const packaged = process.env.COUCHSWARM_PACKAGED_TEST === '1';
// build-helper copies helper/*.mjs verbatim, so byte equality is the freshness test; a stale package
// otherwise reports the source suite's failures as code regressions.
if (packaged) {
  const stale = [];
  for (const file of ['constants.mjs', 'desktop.mjs', 'remote-agent.mjs', 'remote-wire.mjs', 'torrent-helper.mjs'])
    if (await readFile(new URL(`../work/helper-package/app/helper/${file}`, import.meta.url), 'utf8').catch(() => null)
      !== await readFile(new URL(`../helper/${file}`, import.meta.url), 'utf8')) stale.push(file);
  // Byte equality only covers those scripts: a build that failed after copying them leaves a stage whose imports
  // resolve from the repo's own node_modules, beside a ZIP that is not the file people download.
  for (const name of ['webtorrent', '@thaunknown/simple-peer', 'bittorrent-protocol', 'ut_metadata', 'parse-torrent', 'range-parser'])
    if (!await stat(new URL(`../work/helper-package/app/node_modules/${name}/package.json`, import.meta.url)).catch(() => null)) stale.push(name);
  const zip = await stat(new URL('../public/downloads/CouchSwarm-Helper-win-x64.zip', import.meta.url)).catch(() => null);
  const staged = await stat(new URL('../work/helper-package/app/helper/remote-agent.mjs', import.meta.url)).catch(() => null);
  if (!zip || !staged || zip.mtimeMs < staged.mtimeMs) stale.push('CouchSwarm-Helper-win-x64.zip');
  if (stale.length) throw new Error(`work/helper-package is missing or stale (${stale.join(', ')}). Run npm run build:helper.`);
}
const { createRemoteAgent } = await import(packaged ? '../work/helper-package/app/helper/remote-agent.mjs' : '../helper/remote-agent.mjs');
const { serveTorrentPeer } = await import(packaged ? '../work/helper-package/app/helper/remote-wire.mjs' : '../helper/remote-wire.mjs');
const { servedRanges } = await import(packaged ? '../work/helper-package/app/helper/torrent-helper.mjs' : '../helper/torrent-helper.mjs');

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
  const claim = async pairingUrl => post('/api/helper', { action: 'claim', code: new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get('helper') });
  const pair = await post(route, { action: 'pair' }, host.token);
  const grant = await claim(pair.pairingUrl);
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
  const guestGrant = await claim((await post(route, { action: 'pair' }, guest.token)).pairingUrl);
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
  // These two repeats are sequential; the simultaneous case is the unit test below.
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

test('a repeated block request joins the read already in flight', { timeout: 5000 }, async () => {
  const infoHash = 'a'.repeat(40), payload = Buffer.alloc(16384, 7);
  let release, opened = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 16384, pieces: ['x'],
    files: [{ offset: 0, length: 16384, createReadStream() { opened++; const stream = new PassThrough(); void gate.then(() => stream.end(payload)); return stream; } }] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = () => new Promise((resolve, reject) => client.request(0, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const first = ask(), second = ask();
  await sleep(100);
  assert.equal(opened, 1, 'the repeat joined the first read instead of starting another');
  release();
  assert.deepEqual(await Promise.all([first, second]), [payload, payload]);
});

test('a repeated block request queued behind another one is answered twice', { timeout: 5000 }, async () => {
  const infoHash = 'b'.repeat(40), payload = Buffer.alloc(16384, 11);
  const release = [];
  const gates = [0, 1].map(piece => new Promise(resolve => { release[piece] = resolve; }));
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 32768, pieces: ['x', 'y'],
    files: [{ offset: 0, length: 32768, createReadStream({ start }) { const stream = new PassThrough(); void gates[start / 16384].then(() => stream.end(payload)); return stream; } }] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = piece => new Promise((resolve, reject) => client.request(piece, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const ahead = ask(0), first = ask(1), second = ask(1);
  await sleep(100);
  // Answering the request in front swaps the last queued one into its slot, so the two copies now sit in the
  // wire's queue in the opposite order to their callbacks: the reply path has to look its entry up, not assume it.
  release[0]();
  await ahead;
  release[1]();
  assert.deepEqual(await Promise.all([first, second]), [payload, payload]);
});

test('cancelling one copy of a repeated block request still answers the other', { timeout: 5000 }, async () => {
  const infoHash = 'c'.repeat(40), payload = Buffer.alloc(16384, 13);
  const release = [];
  const gates = [0, 1, 2].map(piece => new Promise(resolve => { release[piece] = resolve; }));
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 49152, pieces: ['x', 'y', 'z'],
    files: [{ offset: 0, length: 49152, createReadStream({ start }) { const stream = new PassThrough(); void gates[start / 16384].then(() => stream.end(payload)); return stream; } }] };
  const client = new Wire();
  const wire = serveTorrentPeer(client, torrent);
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = piece => new Promise((resolve, reject) => client.request(piece, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const copies = [ask(0), ask(0)].map(copy => copy.catch(error => error.message));
  const middle = ask(1), last = ask(2);
  await sleep(100);
  // Answering the third request moves the fourth into its slot, so the two copies of the first block are now
  // behind it in the reverse order and the cancel below takes the entry of the copy that was asked for second.
  release[1]();
  await middle;
  client.cancel(0, 0, 16384);
  await sleep(50);
  release[0](); release[2]();
  await last;
  await sleep(50);
  assert.deepEqual(wire.peerRequests, [], 'the cancel leaves no request sitting in the queue owed a reply');
  assert.deepEqual((await Promise.all(copies)).filter(copy => Buffer.isBuffer(copy)), [payload], 'the copy the client kept is still answered');
});

test('a subtitle past the video is advertised and served, and nothing between them is', { timeout: 5000 }, async () => {
  const infoHash = 'd'.repeat(40), subtitle = Buffer.alloc(16384, 17);
  const file = (name, offset, body) => ({ name, path: `Pack/${name}`, offset, length: body.length,
    createReadStream({ start, end }) { const stream = new PassThrough(); stream.end(body.subarray(start, end + 1)); return stream; } });
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 49152, pieces: ['x', 'y', 'z'],
    files: [file('movie.mkv', 0, Buffer.alloc(16384, 1)), file('extras.bin', 16384, Buffer.alloc(16384, 2)), file('en.srt', 32768, subtitle)] };
  const client = new Wire();
  serveTorrentPeer(client, torrent, () => {}, servedRanges(torrent));
  const advertised = new Promise(resolve => client.once('bitfield', resolve));
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  const bitfield = await advertised;
  assert.deepEqual([0, 1, 2].map(piece => bitfield.get(piece)), [true, false, true], 'only the pieces the helper will answer are advertised');
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = piece => new Promise((resolve, reject) => client.request(piece, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  assert.deepEqual(await ask(2), subtitle, 'a subtitle past the video arrives instead of being refused for the whole timeout');
  await assert.rejects(ask(1), /rejected/, 'the file between them is still one the helper refuses, so it is never written');
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
  const helper = createRemoteAgent({ cacheRoot, pollMs: 100, iceOverride: [], report: value => reports.push(value), createClient: () => nativeClient = new WebTorrent(offline) });
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
  // The reload is scheduled 15 seconds after the failure.
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

test('a kept download gets its own subfolder and outlives the helper', { timeout: 30000 }, async t => {
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
  t.after(async () => { await helper.stop(); if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true }); });
  await helper.pair(pair.pairingUrl);
  let state;
  for (let i = 0; i < 200; i++) {
    state = await post(route, { action: 'status' }, host.token);
    if (state.ready) break;
    await sleep(100);
  }
  assert.equal(state.ready, true, 'the helper loaded the seeded torrent into the folder the user chose');
  const kept = [`torrent-${seeded.infoHash}`];
  assert.deepEqual(await readdir(cacheRoot), kept, 'a torrent the user keeps never writes into the chosen folder itself');
  await helper.stop();
  assert.deepEqual(await readdir(cacheRoot), kept, 'stopping the helper leaves a kept download where the user can find it');
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
