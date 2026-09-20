import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DONE, DOWNLOADING, PENDING, pieceStates, storedAhead } from '../lib/piece-state.ts';

// Ten-byte pieces, and a file that starts and ends inside a piece it shares with a neighbour: pieces 2 to 11.
const file = { offset: 25, length: 90 };
const torrent = (verified: number[], partial: number[] = []) => ({
  pieceLength: 10, destroyed: false,
  bitfield: { get: (index: number) => verified.includes(index) },
  pieces: Array.from({ length: 14 }, (_, index) => verified.includes(index) ? null
    : { length: 10, missing: partial.includes(index) ? 4 : 10 }),
});

test('a file is mapped from its own first piece to its own last, shared ones included', () => {
  const states = pieceStates(torrent([0, 1, 2, 3], [4]), file);
  assert.equal(states?.length, 10, 'pieces 2 to 11 of the torrent, and nothing either side');
  assert.deepEqual([...states!], [DONE, DONE, DOWNLOADING, PENDING, PENDING, PENDING, PENDING, PENDING, PENDING, PENDING]);
});

test('a piece counts as arriving only once some of it is here and none of it has verified', () => {
  // Piece 5 has every byte but has not passed its hash check yet, which is still a piece on its way.
  const states = pieceStates(torrent([2], [3, 5]), file);
  assert.deepEqual([...states!].slice(0, 4), [DONE, DOWNLOADING, PENDING, DOWNLOADING]);
  // A verified piece is dropped from the list entirely, so a null there must not read as anything else.
  assert.equal(pieceStates(torrent([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), file)!.every(state => state === DONE), true);
});

// A 90-byte file against a 90-second movie, so a byte is a second and the arithmetic is readable.
const saved = (verified: number[]) => storedAhead(pieceStates(torrent(verified), file), file, 10, 0, 90);

test('the saved run is measured from the position to the far edge of its last whole piece', () => {
  // Pieces 2 to 5 hold torrent bytes 20 to 59, which is everything up to byte 34 of a file that starts at 25.
  assert.equal(saved([2, 3, 4, 5]), 35);
  assert.equal(storedAhead(pieceStates(torrent([2, 3, 4, 5]), file), file, 10, 10, 90), 25, 'measured from where playback is, not from the start');
  // The end of the run is the end of the file, never the end of the piece hanging past it.
  assert.equal(saved([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 90);
});

test('the run stops at the first piece that is not saved yet', () => {
  assert.equal(saved([2, 3, 5]), 15, 'piece 4 is missing, so the run is pieces 2 and 3');
  assert.equal(saved([2, 3, 4, 5]) > saved([2, 3, 5]), true);
});

test('a position with nothing saved under it answers zero', () => {
  assert.equal(saved([5, 6, 7]), 0, 'the run ahead has to start where playback is');
  assert.equal(saved([]), 0);
  // A piece on its way is not a piece that can be played.
  assert.equal(storedAhead(pieceStates(torrent([], [2, 3]), file), file, 10, 0, 90), 0);
  assert.equal(storedAhead(pieceStates(torrent([2, 3, 4, 5]), file), file, 10, 1000, 90), 0, 'past the end of the file');
});

test('nothing is measured without pieces, a duration, or a file', () => {
  assert.equal(storedAhead(null, file, 10, 0, 90), 0);
  assert.equal(storedAhead(pieceStates(torrent([2, 3]), file), file, 10, 0, 0), 0);
  assert.equal(storedAhead(pieceStates(torrent([2, 3]), file), { offset: 25, length: 0 }, 10, 0, 90), 0);
});

test('nothing is mapped before metadata, after the torrent is gone, or for a file with no bytes', () => {
  assert.equal(pieceStates({ ...torrent([]), bitfield: undefined }, file), null);
  assert.equal(pieceStates({ ...torrent([]), destroyed: true }, file), null);
  assert.equal(pieceStates(torrent([]), { offset: 25, length: 0 }), null);
});
