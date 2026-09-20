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
// Range header; the caller still selects the file itself.
export function followReads(torrent: Pieces, file: { offset: number; length: number }) {
  const first = Math.floor(file.offset / torrent.pieceLength), last = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
  let anchor = first;
  const missing = (from: number, to: number) => { for (let i = from; i < to; i++) if (!torrent.bitfield!.get(i)) return true; return false; };
  torrent.on('idle', () => { if (!torrent.destroyed && missing(first, anchor)) torrent.select(first, anchor - 1, 0); });
  return (range: string) => {
    const start = /^bytes=(\d+)-/.exec(range);
    if (!start || torrent.destroyed) return;
    const piece = Math.max(first, Math.min(last, Math.floor((file.offset + Number(start[1])) / torrent.pieceLength)));
    if (piece >= anchor && !missing(anchor, piece)) return;
    anchor = piece;
    torrent.deselect(first, last);
    torrent.select(anchor, last, 0);
  };
}
