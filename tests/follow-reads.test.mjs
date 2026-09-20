import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebTorrent from 'webtorrent';
import MemoryStore from 'memory-chunk-store';
import { followReads } from '../lib/follow-reads.ts';

const offline = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false };
const destroy = client => new Promise(resolve => client.destroy(resolve));

// Ten-byte pieces, and a file that starts and ends inside a piece it shares with a neighbour: pieces 2 to 11.
function fake(have = []) {
  const calls = [], listeners = [];
  const torrent = { pieceLength: 10, destroyed: false, bitfield: { get: index => have.includes(index) },
    select: (...args) => calls.push(['select', ...args]), deselect: (...args) => calls.push(['deselect', ...args]),
    on: (event, listener) => listeners.push(listener) };
  return { torrent, calls, idle: () => listeners.forEach(listener => listener()), follow: followReads(torrent, { offset: 25, length: 90 }) };
}

test('a read past pieces the background download has not reached restarts it there', () => {
  const { calls, follow } = fake([2, 3]);
  follow('bytes=0-');
  follow('bytes=14-');
  assert.deepEqual(calls, [], 'a read inside what is already saved moves nothing');
  follow('bytes=55-');
  assert.deepEqual(calls, [['deselect', 2, 11], ['select', 8, 11, 0]]);
  follow('bytes=60-99');
  assert.equal(calls.length, 2, 'the next read from the same place moves nothing');
});

test('each read answers the piece it starts in, which is where the player is', () => {
  const { follow } = fake([2, 3]);
  assert.equal(follow('bytes=0-'), 2, 'the file starts inside piece 2');
  assert.equal(follow('bytes=14-'), 3, 'answered even when the download does not move');
  assert.equal(follow('bytes=55-'), 8);
  assert.equal(follow('bytes=900-'), 11, 'a read past the end of the file is clamped to its last piece');
  assert.equal(follow('not a range'), -1);
});

test('a read behind the background download brings it back', () => {
  const { calls, follow } = fake();
  follow('bytes=55-');
  follow('bytes=20-');
  assert.deepEqual(calls.slice(2), [['deselect', 2, 11], ['select', 4, 11, 0]]);
});

test('the pieces a restart skipped are fetched once nothing ahead is left', () => {
  const { calls, follow, idle } = fake([2, 3]);
  idle();
  assert.deepEqual(calls, [], 'nothing was skipped before the first restart');
  follow('bytes=55-');
  idle();
  assert.deepEqual(calls.slice(2), [['select', 2, 7, 0]]);
});

test('a read that names no start, a read past the end and a destroyed torrent are all survivable', () => {
  const { torrent, calls, follow } = fake();
  follow('');
  follow('bytes=-500');
  assert.deepEqual(calls, []);
  follow('bytes=5000-');
  assert.deepEqual(calls, [['deselect', 2, 11], ['select', 11, 11, 0]]);
  torrent.destroyed = true;
  follow('bytes=0-');
  assert.equal(calls.length, 2);
});

test('a real download moves to a read in the middle of the file and returns for the start afterwards', { timeout: 30000 }, async t => {
  const seed = new WebTorrent(offline), viewer = new WebTorrent(offline);
  t.after(() => destroy(seed)); t.after(() => destroy(viewer));
  const payload = Object.assign(randomBytes(64 * 16384), { name: 'movie.mkv' });
  const seeded = await new Promise(resolve => seed.seed(payload, { pieceLength: 16384, announce: [], store: MemoryStore }, resolve));
  // Added from the .torrent itself, so the selections below are all in place before there is a wire to ask.
  const torrent = await new Promise(resolve => viewer.add(seeded.torrentFile, { announce: [], store: MemoryStore, deselect: true, strategy: 'sequential' }, resolve));
  const order = [];
  torrent.on('verified', index => order.push(index));
  const [file] = torrent.files;
  file.select();
  followReads(torrent, file)(`bytes=${40 * 16384}-`);
  torrent.addPeer(`127.0.0.1:${seed.torrentPort}`);
  await new Promise(resolve => torrent.once('done', resolve));
  assert.equal(order.length, 64);
  assert.ok(order.slice(0, 24).every(index => index >= 40), `pieces behind the read arrived first: ${order.slice(0, 24).join(',')}`);
  assert.deepEqual(order.slice(24).toSorted((a, b) => a - b), Array.from({ length: 40 }, (_, index) => index));
});
