// The part of a torrent this needs, so the test can hand it WebTorrent's Node build.
type Pieces = {
  pieceLength: number; destroyed?: boolean; bitfield?: { get(index: number): boolean };
  select(start: number, end: number, priority: number): void; deselect(start: number, end: number): void;
  on(event: 'idle', listener: () => void): unknown;
};

// Selecting a file fills it from its first piece and never looks at the playhead, so after a late join or a
// seek every request the player was not making that instant went to pieces behind it, and the movie ahead was
// only ever fetched a fragment at a time. Each read the player makes says where it is: one behind the
// background download, or past a hole it has not reached, restarts the download there. WebTorrent merges
// selections that touch into one that starts over at the lower end, so the old one is dropped first and the
// pieces that were skipped wait until nothing ahead is left to fetch. Returns what to call with each read's
// Range header, which answers the piece that read starts in — the one place anything knows where the player
// actually is in the file, since a position in seconds only maps back to a byte at an average bitrate.
export function followReads(torrent: Pieces, file: { offset: number; length: number }) {
  const first = Math.floor(file.offset / torrent.pieceLength), last = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
  let anchor = first;
  const missing = (from: number, to: number) => { for (let i = from; i < to; i++) if (!torrent.bitfield!.get(i)) return true; return false; };
  torrent.on('idle', () => { if (!torrent.destroyed && missing(first, anchor)) torrent.select(first, anchor - 1, 0); });
  return (range: string) => {
    const start = /^bytes=(\d+)-/.exec(range);
    if (!start || torrent.destroyed) return -1;
    const piece = Math.max(first, Math.min(last, Math.floor((file.offset + Number(start[1])) / torrent.pieceLength)));
    if (piece >= anchor && !missing(anchor, piece)) return piece;
    anchor = piece;
    torrent.deselect(first, last);
    torrent.select(anchor, last, 0);
    return piece;
  };
}

// A Range header names only the piece a read starts in, and a <video> element keeps one open-ended read going for
// as long as it plays forward, so that piece falls further behind the player with every second watched: a saved run
// counted from there takes in everything already played. Passing the read's own chunks through here answers the
// piece it has really got to. Cancelling is handed straight on, never queued behind a chunk that has not arrived as
// an async generator would queue it, because that return is what gives an abandoned read's pieces back.
export function readProgress(read: AsyncIterable<Uint8Array>, from: number, pieceLength: number, reached: (piece: number) => void): AsyncIterableIterator<Uint8Array> {
  const iterator = read[Symbol.asyncIterator]();
  let at = from;
  return {
    [Symbol.asyncIterator]() { return this; },
    next: async () => {
      const chunk = await iterator.next();
      if (!chunk.done) { at += chunk.value.length; reached(Math.floor((at - 1) / pieceLength)); }
      return chunk;
    },
    return: async () => iterator.return ? iterator.return() : { done: true, value: undefined },
  };
}
