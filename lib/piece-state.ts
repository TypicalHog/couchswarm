// What the bar under the file name draws. WebTorrent holds a Piece object for every piece it has not verified
// and counts its `missing` bytes down as blocks land, so a piece that is partly here is one being fetched right
// now; a verified piece has no object left at all. Both are what the client's own `downloaded` getter reads.
export const PENDING = 0, DOWNLOADING = 1, DONE = 2;

type Pieces = {
  pieceLength: number; destroyed: boolean;
  bitfield?: { get(index: number): boolean };
  pieces: ({ length: number; missing: number } | null)[];
};

// How many seconds of video are saved in an unbroken run past the piece the player is reading. A browser sizes
// the player's own forward buffer for itself, and on a progressive file it settles a second or two short of the
// room's readiness target however much of the movie is already on disk — so this is what really says whether a
// seat can play on. It starts from the read rather than from a position in seconds, because seconds only map
// back to a byte at an average bitrate, and a seat that joined mid-movie is nowhere near where that points.
// The length of the run is still averaged, which a long run makes harmless.
export function storedAhead(states: Uint8Array | null, file: { offset: number }, pieceLength: number, reading: number, secondsPerByte: number) {
  if (!states?.length || !(secondsPerByte > 0)) return 0;
  // An index off either end reads undefined, which is not DONE, so a read outside the file answers zero.
  const from = reading - Math.floor(file.offset / pieceLength);
  if (states[from] !== DONE) return 0;
  let last = from;
  while (states[last + 1] === DONE) last++;
  // Whole pieces past the one being read: part of that one has been played already.
  return (last - from) * pieceLength * secondsPerByte;
}

// One byte per piece of the chosen video, in file order. Null until the torrent has metadata to say what its
// pieces are, and for a file too small to own one.
export function pieceStates(torrent: Pieces, file: { offset: number; length: number }) {
  if (torrent.destroyed || !torrent.bitfield || !file.length) return null;
  const first = Math.floor(file.offset / torrent.pieceLength);
  const last = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
  const states = new Uint8Array(last - first + 1);
  for (let index = first; index <= last; index++) {
    const piece = torrent.pieces[index];
    states[index - first] = torrent.bitfield.get(index) ? DONE
      : piece && piece.missing < piece.length ? DOWNLOADING : PENDING;
  }
  return states;
}
