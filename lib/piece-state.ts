// What the bar under the file name draws. WebTorrent holds a Piece object for every piece it has not verified
// and counts its `missing` bytes down as blocks land, so a piece that is partly here is one being fetched right
// now; a verified piece has no object left at all. Both are what the client's own `downloaded` getter reads.
export const PENDING = 0, DOWNLOADING = 1, DONE = 2;

type Pieces = {
  pieceLength: number; destroyed: boolean;
  bitfield?: { get(index: number): boolean };
  pieces: ({ length: number; missing: number } | null)[];
};

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
