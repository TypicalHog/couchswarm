// What the bar under the file name draws. WebTorrent holds a Piece object for every piece it has not verified
// and counts its `missing` bytes down as blocks land, so a piece that is partly here is one being fetched right
// now; a verified piece has no object left at all. Both are what the client's own `downloaded` getter reads.
export const PENDING = 0, DOWNLOADING = 1, DONE = 2;

type Pieces = {
  pieceLength: number; destroyed: boolean;
  bitfield?: { get(index: number): boolean };
  pieces: ({ length: number; missing: number } | null)[];
};

// How many seconds of video are saved in an unbroken run from a position. A browser sizes the player's own
// forward buffer for itself, and on a progressive file it settles a second or two short of the room's readiness
// target however much of the movie is already on disk — so the run of pieces ahead of the playhead is what
// really says whether this seat can play on. Time maps to bytes at the file's average rate: a variable bitrate
// makes that approximate, which is enough to answer whether the next few seconds are here.
export function storedAhead(states: Uint8Array | null, file: { offset: number; length: number }, pieceLength: number, position: number, duration: number) {
  if (!states?.length || !(duration > 0) || !(file.length > 0)) return 0;
  const rate = file.length / duration;
  const first = Math.floor(file.offset / pieceLength);
  // An index off either end reads undefined, which is not DONE, so a position outside the file answers zero.
  const at = Math.floor((file.offset + Math.min(file.length - 1, position * rate)) / pieceLength) - first;
  if (states[at] !== DONE) return 0;
  let last = at;
  while (states[last + 1] === DONE) last++;
  // The run reaches the far edge of its last saved piece, and the file ends where it ends.
  const end = Math.min(file.length, (first + last + 1) * pieceLength - file.offset);
  return Math.max(0, end / rate - position);
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
