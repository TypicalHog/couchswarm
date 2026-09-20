import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allReady, bufferedAhead, estimateServerNow, hasBuffer, SPECTATOR_EPOCH, timelinePosition, validSource, type Room } from '../lib/sync.ts';

const room: Room = { id: 'room', hostId: 'host', source: '', fileIndex: 0, mediaVersion: 0, epoch: 3,
  revision: 1, playing: true, position: 20, startsAt: 10000, duration: 100, reason: '' };

test('clock estimate excludes server processing from network delay', () => {
  assert.equal(estimateServerNow(1100, 1000, 200), 1150);
  assert.equal(estimateServerNow(1100, 1000, 90), 1100);
});

test('scheduled playback holds position until the shared deadline and clamps at the end', () => {
  assert.equal(timelinePosition(room, 9000), 20);
  assert.equal(timelinePosition(room, 12500), 22.5);
  assert.equal(timelinePosition(room, 200000), 100);
  assert.equal(timelinePosition({ ...room, duration: 0 }, 200000), 210);
  assert.equal(timelinePosition({ ...room, playing: false }, 12000), 20);
});

test('buffer readiness measures playable time at the target, not total downloaded bytes', () => {
  const ranges = { length: 2, start: (i: number) => [0, 50][i], end: (i: number) => [12, 65][i] };
  assert.equal(bufferedAhead(ranges, 4), 8);
  assert.equal(bufferedAhead(ranges, 40), 0);
  assert.equal(bufferedAhead(ranges, 55), 10);
  assert.equal(bufferedAhead({ length: 1, start: () => 4.1, end: () => 12 }, 4), 8);
  assert.equal(bufferedAhead({ length: 1, start: () => 4.2, end: () => 12 }, 4), 0);
  const seamed = { length: 3, start: (i: number) => [0, 2.05, 5][i], end: (i: number) => [2, 4.5, 30][i] };
  assert.equal(bufferedAhead(seamed, 0), 4.5);
  assert.equal(bufferedAhead({ length: 2, start: (i: number) => [0, 2.1][i], end: (i: number) => [2, 30][i] }, 0), 30);
  assert.equal(bufferedAhead({ length: 0, start: () => 0, end: () => 0 }, 0), 0);
  const chained = { length: 4, start: (i: number) => [0, 1.05, 2.05, 9][i], end: (i: number) => [1, 2, 3, 12][i] };
  assert.equal(bufferedAhead(chained, 0), 3);
  assert.equal(bufferedAhead({ length: 2, start: (i: number) => [0, 1.095][i], end: (i: number) => [1, 5][i] }, 0), 5);
  assert.equal(bufferedAhead({ length: 2, start: (i: number) => [0, 1.2][i], end: (i: number) => [1, 5][i] }, 0), 1);
  assert.equal(hasBuffer(7, 0, 100, false), false);
  assert.equal(hasBuffer(8, 0, 100, false), true);
  assert.equal(hasBuffer(2, 98, 100, false), true);
  assert.equal(hasBuffer(0, 99.7, 100, false), false);
  assert.equal(hasBuffer(0, 99.85, 100, false), true);
  assert.equal(hasBuffer(0, 100, 100, true), true);
  assert.equal(hasBuffer(0, 50, 100, false), false);
  assert.equal(hasBuffer(0, 0, 0, false), false);
  assert.equal(hasBuffer(2.9, 0, 100, true), false);
  assert.equal(hasBuffer(3, 0, 100, true), true);
});

test('a stale epoch, absent host, or unready guest closes the shared play gate', () => {
  const host = { id: 'host', name: 'Host', ready: true, buffered: 8, progress: .1, epoch: 3, lastSeen: 20000 };
  const guest = { ...host, id: 'guest' };
  assert.equal(allReady([host, guest], room, 20000), true);
  assert.equal(allReady([host, { ...guest, epoch: 2 }], room, 20000), false);
  assert.equal(allReady([host, { ...guest, ready: false }], room, 20000), false);
  assert.equal(allReady([host, { ...guest, ready: false, epoch: SPECTATOR_EPOCH }], room, 20000), true);
  assert.equal(allReady([guest], room, 20000), false);
  assert.equal(allReady([host, guest], room, 33000), false);
});

test('rejects malformed torrent input and unsafe URL schemes', () => {
  assert.equal(validSource('magnet:?xt=urn:btih:' + 'a'.repeat(40)), true);
  assert.equal(validSource('magnet:?xt=urn:btih:bad'), false);
  assert.equal(validSource('magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), true);
  assert.equal(validSource('magnet:?xt=urn:btih:bad&xt=urn:btih:' + 'a'.repeat(40)), true);
  assert.equal(validSource('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=' + 'y'.repeat(8192)), false);
  // The control characters ride in a parameter the btih check never looks at, so only the Cc clause rejects them.
  assert.equal(validSource('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=a\nb'), false);
  assert.equal(validSource('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=a\0b'), false);
  assert.equal(validSource('https://example.org/movie.torrent?download=1'), true);
  assert.equal(validSource('http://example.org/movie.torrent'), false);
  assert.equal(validSource('javascript:alert(1)'), false);
  assert.equal(validSource('https://user:password@example.org/movie.torrent'), false);
});
