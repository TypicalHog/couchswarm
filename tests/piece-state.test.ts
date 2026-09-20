import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DONE, DOWNLOADING, PENDING, pieceStates } from '../lib/piece-state.ts';

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

test('nothing is mapped before metadata, after the torrent is gone, or for a file with no bytes', () => {
  assert.equal(pieceStates({ ...torrent([]), bitfield: undefined }, file), null);
  assert.equal(pieceStates({ ...torrent([]), destroyed: true }, file), null);
  assert.equal(pieceStates(torrent([]), { offset: 25, length: 0 }), null);
});
