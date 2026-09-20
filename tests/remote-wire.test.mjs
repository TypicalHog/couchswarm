import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import Wire from 'bittorrent-protocol';
const packaged = process.env.COUCHSWARM_PACKAGED_TEST === '1';
// serveTorrentPeer is what a room member's browser talks to, and bittorrent-protocol validates nothing before handing
// a request over, so its guards are all that keeps a patched client inside the span the helper validated and sparsed.
// They need a suite with no server behind it; the packaged tree's freshness is checked in tests/remote-helper.test.mjs.
const { serveTorrentPeer } = await import(packaged ? '../work/helper-package/app/helper/remote-wire.mjs' : '../helper/remote-wire.mjs');
const { servedRanges } = await import(packaged ? '../work/helper-package/app/helper/torrent-helper.mjs' : '../helper/torrent-helper.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// serveTorrentPeer reads a verified piece straight out of the torrent's store and waits on a 'verified' event for one
// that has not landed yet, so a fake torrent has to carry the same surface webtorrent does: a bitfield, a store, and
// the per-piece stream selection that wait takes out. deliver() is the swarm fetch the helper is waiting for — write
// the piece, then announce it — and `selections` is what stays parked in the meantime, which is the whole point of
// waiting once per piece instead of once per block.
function fakeTorrent(infoHash, { pieceLength = 16384, count = 1, length = count * pieceLength, files = [] } = {}) {
  const written = new Map();
  const torrent = Object.assign(new EventEmitter(), {
    infoHash, torrentFile: null, pieceLength, length, files, destroyed: false, selections: 0, reads: 0,
    pieces: Array.from({ length: count }, () => 'x'),
    bitfield: { get: piece => written.has(piece) },
    store: { get: (piece, span, callback) => { torrent.reads++; callback(null, written.get(piece).subarray(span.offset, span.offset + span.length)); } },
    _select: () => { torrent.selections++; },
    _deselect: () => { torrent.selections--; },
    critical: () => {},
    deliver: (piece, body) => { written.set(piece, body); torrent.emit('verified', piece); },
  });
  return torrent;
}

test('a repeated block request joins the read already in flight', { timeout: 5000 }, async () => {
  const infoHash = 'a'.repeat(40), payload = Buffer.alloc(16384, 7);
  const torrent = fakeTorrent(infoHash);
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = () => new Promise((resolve, reject) => client.request(0, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const first = ask(), second = ask();
  await sleep(100);
  assert.equal(torrent.selections, 1, 'the repeat joined the first read instead of starting another');
  torrent.deliver(0, payload);
  assert.deepEqual(await Promise.all([first, second]), [payload, payload]);
  assert.equal(torrent.reads, 1, 'both copies are answered from the one read of the piece');
  assert.equal(torrent.selections, 0, 'the piece is handed back once it has landed');
});

// Every block of a piece used to take out its own stream selection, and webtorrent re-sorts and garbage-collects that
// list on each one: a full room parks thousands. They all wait on the same piece now.
test('every block of one piece waits on a single selection', { timeout: 5000 }, async () => {
  const infoHash = '5'.repeat(40), piece = Buffer.alloc(65536, 19);
  const torrent = fakeTorrent(infoHash, { pieceLength: 65536 });
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = offset => new Promise((resolve, reject) => client.request(0, offset, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const blocks = [0, 16384, 32768, 49152].map(ask);
  await sleep(100);
  assert.equal(torrent.selections, 1, 'four blocks of one piece hold one selection between them');
  torrent.deliver(0, piece);
  assert.deepEqual(await Promise.all(blocks), [0, 16384, 32768, 49152].map(offset => piece.subarray(offset, offset + 16384)));
  assert.equal(torrent.selections, 0, 'the last block to be answered hands the piece back');
});

test('a repeated block request queued behind another one is answered twice', { timeout: 5000 }, async () => {
  const infoHash = 'b'.repeat(40), payload = Buffer.alloc(16384, 11);
  const torrent = fakeTorrent(infoHash, { count: 2 });
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, Buffer.concat([Buffer.from('-TE0001-'), Buffer.alloc(12, 1)]), { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = piece => new Promise((resolve, reject) => client.request(piece, 0, 16384, (error, data) => error ? reject(error) : resolve(Buffer.from(data))));
  const ahead = ask(0), first = ask(1), second = ask(1);
  await sleep(100);
  // Answering the request in front swaps the last queued one into its slot, so the two copies now sit in the
  // wire's queue in the opposite order to their callbacks: the reply path has to look its entry up, not assume it.
  torrent.deliver(0, payload);
  await ahead;
  torrent.deliver(1, payload);
  assert.deepEqual(await Promise.all([first, second]), [payload, payload]);
});

test('cancelling one copy of a repeated block request still answers the other', { timeout: 5000 }, async () => {
  const infoHash = 'c'.repeat(40), payload = Buffer.alloc(16384, 13);
  const torrent = fakeTorrent(infoHash, { count: 3 });
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
  torrent.deliver(1, payload);
  await middle;
  client.cancel(0, 0, 16384);
  await sleep(50);
  torrent.deliver(0, payload); torrent.deliver(2, payload);
  await last;
  await sleep(50);
  assert.deepEqual(wire.peerRequests, [], 'the cancel leaves no request sitting in the queue owed a reply');
  assert.deepEqual((await Promise.all(copies)).filter(copy => Buffer.isBuffer(copy)), [payload], 'the copy the client kept is still answered');
});

test('a subtitle past the video is advertised and served, and nothing between them is', { timeout: 5000 }, async () => {
  const infoHash = 'd'.repeat(40), subtitle = Buffer.alloc(16384, 17);
  const file = (name, offset) => ({ name, path: `Pack/${name}`, offset, length: 16384 });
  const torrent = fakeTorrent(infoHash, { count: 3, files: [file('movie.mkv', 0), file('extras.bin', 16384), file('en.srt', 32768)] });
  // Already downloaded, so this is also the only test that covers reading a verified piece without waiting for it.
  torrent.deliver(2, subtitle);
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
  const torrent = fakeTorrent('e'.repeat(40));
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  let answered = false;
  client.on('handshake', () => { answered = true; });
  const closed = once(client, 'finish');
  client.handshake('f'.repeat(40), peerId, { fast: true });
  await closed;
  assert.equal(answered, false, 'a peer asking for another torrent never learns we hold this one');
});

test('a block request outside its piece is refused before the torrent is touched', { timeout: 5000 }, async () => {
  const infoHash = '1'.repeat(40);
  const torrent = fakeTorrent(infoHash, { count: 2, length: 24576 });
  const client = new Wire();
  serveTorrentPeer(client, torrent);
  client.handshake(infoHash, peerId, { fast: true });
  await new Promise(resolve => { client.once('unchoke', resolve); client.interested(); });
  const ask = (piece, offset, length) => new Promise((resolve, reject) => client.request(piece, offset, length, error => error ? reject(error) : resolve()));
  // Past the short last piece, past a whole piece, a block larger than the 128 KiB one, an empty one, and a piece
  // the torrent does not have: each would read bytes the helper never sized or promised.
  for (const block of [[1, 4096, 8192], [0, 16000, 1000], [0, 0, 200 * 1024], [0, 0, 0], [2, 0, 16384]])
    await assert.rejects(ask(...block), /rejected/, `block ${block.join(':')} is refused`);
  assert.equal(torrent.selections + torrent.reads, 0, 'a refused request never reaches the torrent, so nothing is downloaded or written for it');
});

// A read that never ends holds its block, so `blocks` of them are all outstanding when the next one arrives.
async function flood(blocks, length) {
  const infoHash = '2'.repeat(40);
  const torrent = fakeTorrent(infoHash, { pieceLength: length, count: blocks + 1 });
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
  const torrent = fakeTorrent(infoHash);
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
  const torrent = fakeTorrent(infoHash);
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
