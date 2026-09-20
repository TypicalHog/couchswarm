import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import Wire from 'bittorrent-protocol';
const packaged = process.env.COUCHSWARM_PACKAGED_TEST === '1';
// serveTorrentPeer is what a room member's browser talks to, and bittorrent-protocol validates nothing before handing
// a request over, so its guards are all that keeps a patched client inside the span the helper validated and sparsed.
// They need a suite with no server behind it; the packaged tree's freshness is checked in tests/remote-helper.test.mjs.
const { serveTorrentPeer } = await import(packaged ? '../work/helper-package/app/helper/remote-wire.mjs' : '../helper/remote-wire.mjs');
const { servedRanges } = await import(packaged ? '../work/helper-package/app/helper/torrent-helper.mjs' : '../helper/torrent-helper.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Nothing below is reachable through a stock browser client, so every one of these guards would stay green under any
// suite that only drives a well-behaved viewer. Each asserts the refusal a patched one meets instead.
const peerId = Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]);

test('a handshake for another torrent is served nothing and closed', { timeout: 5000 }, async () => {
  const torrent = { infoHash: 'e'.repeat(40), torrentFile: null, pieceLength: 16384, length: 16384, pieces: ['x'], files: [] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  let answered = false;
  client.on('handshake', () => { answered = true; });
  const closed = once(client, 'finish');
  client.handshake('f'.repeat(40), peerId, { fast: true });
  await closed;
  assert.equal(answered, false, 'a peer asking for another torrent never learns we hold this one');
});

test('a block request outside its piece is refused before a file is opened', { timeout: 5000 }, async () => {
  const infoHash = '1'.repeat(40);
  let opened = 0;
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 24576, pieces: ['x', 'y'],
    files: [{ offset: 0, length: 24576, createReadStream() { opened++; const stream = new PassThrough(); stream.end(Buffer.alloc(16384)); return stream; } }] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, peerId, { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = (piece, offset, length) => new Promise((resolve, reject) => client.request(piece, offset, length, error => error ? reject(error) : resolve()));
  // Past the short last piece, past a whole piece, a block larger than the 128 KiB one, an empty one, and a piece
  // the torrent does not have: each would read bytes the helper never sized or promised.
  for (const block of [[1, 4096, 8192], [0, 16000, 1000], [0, 0, 200 * 1024], [0, 0, 0], [2, 0, 16384]])
    await assert.rejects(ask(...block), /rejected/, `block ${block.join(':')} is refused`);
  assert.equal(opened, 0, 'a refused request never reaches the torrent, so nothing is downloaded or written for it');
});

// A read that never ends holds its block, so `blocks` of them are all outstanding when the next one arrives.
async function flood(blocks, length) {
  const infoHash = '2'.repeat(40), total = (blocks + 1) * length;
  const torrent = { infoHash, torrentFile: null, pieceLength: length, length: total, pieces: Array.from({ length: blocks + 1 }, () => 'x'),
    files: [{ offset: 0, length: total, createReadStream: () => new PassThrough() }] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, peerId, { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = piece => new Promise((resolve, reject) => client.request(piece, 0, length, error => error ? reject(error) : resolve()));
  for (let piece = 0; piece < blocks; piece++) void ask(piece).catch(() => {});
  await sleep(100);
  return ask(blocks);
}

test('a viewer is refused once its outstanding blocks fill the wire', { timeout: 20000 }, async () => {
  // 256 small blocks reach the request count on their own; 32 x 128 KiB reach the 4 MiB cap with the count to spare.
  await assert.rejects(flood(256, 4096), /rejected/, 'the request after MAX_REQUESTS is refused instead of opening another read');
  await assert.rejects(flood(32, 128 * 1024), /rejected/, 'a block that would take the wire past MAX_REQUEST_BYTES is refused');
});

test('a stack of duplicate block requests closes the channel', { timeout: 5000 }, async () => {
  const infoHash = '3'.repeat(40);
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 16384, pieces: ['x'],
    files: [{ offset: 0, length: 16384, createReadStream: () => new PassThrough() }] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, peerId, { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const closed = once(client, 'finish');
  // Refusing a duplicate cannot drain the entry it made in bittorrent-protocol's queue, so past MAX_DUPLICATES the
  // channel is the only thing left to take away.
  for (let copy = 0; copy <= 8; copy++) client.request(0, 0, 16384, () => {});
  await closed;
});

test('a frame too large to be a control message closes the channel', { timeout: 5000 }, async () => {
  const infoHash = '4'.repeat(40);
  const torrent = { infoHash, torrentFile: null, pieceLength: 16384, length: 16384, pieces: ['x'], files: [] };
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  const closed = once(client, 'finish');
  client.handshake(infoHash, peerId, { fast: true });
  await once(client, 'handshake');
  // A length prefix no control message could fill, then more of it than the parser will hold. The backlog is measured
  // as each chunk arrives, so it is the chunk after the one that overflows it that finds the wire over the limit.
  const frame = Buffer.alloc(4 + 300 * 1024);
  frame.writeUInt32BE(1024 * 1024, 0);
  client.push(frame);
  await sleep(50);
  client.push(Buffer.alloc(1024));
  await closed;
});
