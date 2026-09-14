import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebTorrent from 'webtorrent';
import MemoryStore from 'memory-chunk-store';
import { createTorrentHelper, torrentPathIssue, torrentSource } from '../helper/torrent-helper.mjs';

// Offline by default, so a helper built without the createClient below still cannot reach the DHT or a public tracker.
process.env.COUCHSWARM_HELPER_OFFLINE ??= '1';
const token = 'a'.repeat(64);
const roomId = '12345678-1234-1234-1234-123456789abc';
const offline = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false };
const destroy = client => new Promise(resolve => client.destroy(resolve));

async function setup(t, files, options = {}) {
  const seedClient = new WebTorrent(offline);
  const seeder = await new Promise((resolve, reject) => {
    seedClient.on('error', reject);
    seedClient.seed(files, { store: MemoryStore, name: Array.isArray(files) ? 'Test room' : files.name, announce: [], pieceLength: 16384 }, resolve);
  });
  let source = seeder.magnetURI;
  const server = http.createServer((req, res) => {
    if (req.url === `/api/rooms/${roomId}`) {
      res.writeHead(req.headers.authorization === `Bearer ${token}` ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ room: { source, mediaVersion: 1, fileIndex: 0 } }));
    } else void helper.handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cacheRoot = await mkdtemp(path.join(tmpdir(), 'couchswarm-helper-test-'));
  let clients = 0;
  const nativeClients = [];
  const helper = createTorrentHelper({ siteOrigin: origin, cacheRoot, ...options,
    createClient() {
      clients++;
      const client = new WebTorrent(offline);
      nativeClients.push(client);
      const add = client.add.bind(client);
      client.add = (...args) => {
        const torrent = add(...args);
        torrent.once('infoHash', () => torrent.addPeer(`127.0.0.1:${seedClient.torrentPort}`));
        return torrent;
      };
      return client;
    },
  });
  t.after(async () => {
    server.close(); server.closeAllConnections();
    await helper.close(); await destroy(seedClient);
    if (path.dirname(cacheRoot) === tmpdir()) await rm(cacheRoot, { recursive: true, force: true });
  });
  const call = (pathname, init = {}) => fetch(`${origin}/torrent-helper${pathname}`, init);
  const open = async (authorization = `Bearer ${token}`, extra = {}) => {
    const response = await call('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization, ...extra }, body: JSON.stringify({ roomId }) });
    return { status: response.status, ...await response.json() };
  };
  const ready = async id => {
    for (let i = 0; i < 100; i++) {
      const state = await (await call(`/sessions/${id}`)).json();
      if (state.error) return state;
      if (state.ready) return state;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Helper never received metadata from the TCP seeder.');
  };
  return { call, open, ready, seeder, origin, cacheRoot, nativeClients, close: () => helper.close(), clients: () => clients, setSource: value => { source = value; } };
}

test('helper obtains magnet metadata over TCP and serves verified single-file ranges to two viewers', { timeout: 20000 }, async t => {
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  payload.name = 'movie.mp4';
  const env = await setup(t, payload);
  assert.equal((await env.open('Bearer ' + 'b'.repeat(64))).status, 401);
  assert.equal((await env.open(`Bearer ${token}`, { Origin: 'https://unrelated.example' })).status, 403);
  assert.deepEqual(await (await env.call('/health')).json(), { available: true });
  assert.equal((await env.call('/sessions', { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` }, body: '{}' })).status, 415);
  assert.equal((await env.call('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ roomId: 'not-a-room' }) })).status, 400);
  assert.equal((await env.call('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ roomId, pad: 'x'.repeat(2000) }) })).status, 400, 'an oversized request body is rejected before parsing');
  const first = await env.open();
  const second = await env.open();
  assert.equal(first.status, 201);
  assert.notEqual(first.id, second.id);
  const state = await env.ready(first.id);
  assert.equal(state.ready, true, state.error);
  assert.equal(env.clients(), 1, 'viewers share one native torrent download');
  const metadata = new Uint8Array(await (await env.call(`/metadata/${first.id}`)).arrayBuffer());
  const browser = new WebTorrent(offline);
  t.after(() => destroy(browser));
  const received = await new Promise((resolve, reject) => {
    browser.on('error', reject);
    browser.add(metadata, { store: MemoryStore }, torrent => {
      torrent.on('error', reject);
      torrent.addWebSeed(`${env.origin}/torrent-helper/seed/${first.id}`);
      torrent.once('done', async () => resolve(Buffer.from(await torrent.files[0].arrayBuffer())));
    });
  });
  assert.deepEqual(received, Buffer.from(payload), 'the browser-side client verifies all pieces delivered through HTTPS-compatible webseed requests');
  const head = await env.call(`/seed/${first.id}`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(payload.length));
  for (const [start, end] of [[0, 0], [0, 8191], [150000, 170000]]) {
    const response = await env.call(`/seed/${first.id}`, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${payload.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(start, end + 1));
  }
  assert.equal((await env.call(`/seed/${first.id}`, { headers: { Range: 'bytes=999999-' } })).status, 416);
  assert.equal((await env.call(`/seed/${first.id}`, { headers: { Range: 'bytes=-999999' } })).status, 206, 'an oversized suffix range returns the whole representation');
  for (const range of ['bytes=0-1, 4-5', 'bytes=abc']) {
    const response = await env.call(`/seed/${first.id}`, { headers: { Range: range } });
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get('content-range'), null, range);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(payload), 'a malformed or multi-range header returns the whole body');
  }
  assert.equal((await env.call(`/seed/${first.id}`, { method: 'POST' })).status, 405);
  const traversal = await env.call(`/seed/${first.id}/..%2f..%2fREADME.md`);
  assert.equal(traversal.status, 404); assert.match((await traversal.json()).error, /not in the torrent/, 'the encoded traversal reaches the torrent file lookup');
  const shared = await env.call(`/seed/${second.id}`, { headers: { Range: 'bytes=0-8191' } });
  assert.equal(shared.status, 206);
  assert.deepEqual(Buffer.from(await shared.arrayBuffer()), payload.subarray(0, 8192), 'the second viewer is served verified bytes from the shared download');
  await env.call(`/sessions/${first.id}`, { method: 'DELETE' });
  assert.equal((await env.call(`/metadata/${first.id}`)).status, 410);
  assert.equal((await env.call(`/metadata/${second.id}`)).status, 200, 'one viewer leaving keeps others connected');
  await env.call(`/sessions/${second.id}`, { method: 'DELETE' });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.notEqual((await readdir(env.cacheRoot)).length, 0, 'the grace window keeps the download for a viewer who reconnects');
  await env.close();
  assert.deepEqual(await readdir(env.cacheRoot), [], 'closing the helper deletes the cache the grace window held');
});

test('multi-file webseed handles spaces, unicode, and pieces spanning file boundaries', { timeout: 20000 }, async t => {
  const files = [Object.assign(Buffer.alloc(17001, 17), { name: 'movie č.mp4' }), Object.assign(Buffer.alloc(37003, 42), { name: 'extra file.bin' })];
  const env = await setup(t, files);
  const lease = await env.open();
  assert.equal((await env.ready(lease.id)).ready, true);
  assert.equal((await env.call(`/seed/${lease.id}/sub%2f..%2f..%2fREADME.md`)).status, 404);
  const metadata = new Uint8Array(await (await env.call(`/metadata/${lease.id}`)).arrayBuffer());
  const browser = new WebTorrent(offline);
  t.after(() => destroy(browser));
  const torrent = await new Promise(resolve => browser.add(metadata, { store: MemoryStore }, resolve));
  const done = once(torrent, 'done');
  torrent.addWebSeed(`${env.origin}/torrent-helper/seed/${lease.id}`);
  await done;
  for (const file of torrent.files) {
    const expected = files.find(value => value.name === file.name);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(expected));
  }
  const [cached] = await readdir(env.cacheRoot);
  await env.call(`/sessions/${lease.id}`, { method: 'DELETE' });
  const again = await env.open();
  assert.equal((await env.ready(again.id)).ready, true);
  assert.equal(env.clients(), 1, 'a viewer reconnecting inside the grace window reuses the held download');
  await env.call(`/sessions/${again.id}`, { method: 'DELETE' });
  env.setSource('magnet:?xt=urn:btih:' + 'c'.repeat(40));
  await env.open();
  for (let i = 0; i < 100 && (await readdir(env.cacheRoot)).includes(cached); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await readdir(env.cacheRoot)).includes(cached), false, 'a new torrent evicts the session-less download the grace window held');
});

test('helper rejects private-network metadata URLs and expires inactive viewers', { timeout: 15000 }, async t => {
  const payload = Object.assign(Buffer.alloc(32768, 1), { name: 'movie.mp4' });
  const env = await setup(t, payload, { idleMs: 1000 });
  const busy = await env.open();
  const keepAlive = setInterval(() => void env.call(`/sessions/${busy.id}`).catch(() => {}), 300);
  t.after(() => clearInterval(keepAlive));
  env.setSource('https://127.0.0.1/private.torrent');
  const local = await env.open();
  assert.match((await env.ready(local.id)).error, /public internet/);
  assert.equal((await env.call(`/seed/${local.id}`)).status, 503);
  // The sweep ticks every idleMs and releases when idle exceeds it, so release lands by seen + 2 * idleMs.
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.equal((await env.call(`/sessions/${local.id}`)).status, 410);
  clearInterval(keepAlive);
  assert.equal((await env.call(`/sessions/${busy.id}`)).status, 200, 'a polled lease survives the sweep');
});

test('a magnet cannot point the helper at the private network', { timeout: 5000 }, async () => {
  const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40)
    + '&x.pe=127.0.0.1:6881&x.pe=10.0.0.5:6881&x.pe=' + encodeURIComponent('[::1]:6881') + '&x.pe=203.0.113.7:6881'
    + '&tr=' + encodeURIComponent('udp://127.0.0.1:1337') + '&tr=' + encodeURIComponent('http://203.0.113.9/announce')
    + '&tr=' + encodeURIComponent('file:///etc/passwd') + '&tr=' + encodeURIComponent('udp://203.0.113.7:1337')
    + '&ws=' + encodeURIComponent('https://127.0.0.1/f')
    + '&xs=' + encodeURIComponent('https://127.0.0.1/f.torrent')
    + '&as=' + encodeURIComponent('https://127.0.0.1/g.torrent');
  // The filter only runs when offline mode is off, so this one test drops it and puts it back.
  delete process.env.COUCHSWARM_HELPER_OFFLINE;
  try {
    const parsed = await torrentSource(magnet);
    assert.deepEqual(parsed.peerAddresses, ['203.0.113.7:6881'], 'only public IP-literal peer hints survive');
    assert.deepEqual(parsed.announce, ['udp://203.0.113.7:1337'], 'only public udp, ws and wss trackers survive');
    assert.deepEqual(parsed.urlList, []);
    assert.deepEqual([parsed.xs, parsed.as], [undefined, undefined]);
  } finally { process.env.COUCHSWARM_HELPER_OFFLINE = '1'; }
  const offlineParsed = await torrentSource(magnet);
  assert.equal(offlineParsed.peerAddresses.length, 4, 'offline mode keeps loopback hints so the suites can seed locally');
  assert.equal(offlineParsed.announce.length, 4);
});

test('torrentPathIssue rejects only the paths Windows cannot store', { timeout: 5000 }, async () => {
  const torrentOf = (...paths) => ({ pieceLength: 16384,
    files: paths.map((value, index) => ({ name: value.split('/').pop(), path: value, length: 100, offset: index * 100 })) });
  for (const entry of ['Pack/NUL.mkv', 'Pack./Movie.mkv'])
    assert.match(torrentPathIssue(torrentOf(entry)), /Windows cannot create/, entry);
  assert.match(torrentPathIssue(torrentOf('Movie.mkv', '<>')), /Windows cannot create/, 'a name that sanitises to nothing');
  assert.match(torrentPathIssue(torrentOf('Movie.mkv'), 'x'.repeat(250)), /too deep for your download folder/);
  for (const entry of ['com.mkv', 'Contact.mkv', 'nullify.mkv', 'console/x.mkv'])
    assert.equal(torrentPathIssue(torrentOf(entry)), '', entry);
});
