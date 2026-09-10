import { randomBytes } from 'node:crypto';
import Wire from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';

// Outstanding block requests per viewer: 256 x 16 KiB keeps 4 MiB in flight, enough for a distant guest.
const MAX_REQUESTS = 256;

// Advertise availability to our authenticated room only. Each requested block
// is fetched and verified by the native torrent before the browser receives it.
export function serveTorrentPeer(peer, torrent, readAhead = () => {}) {
  const wire = new Wire();
  const reads = new Map();
  wire.extendedHandshake.reqq = MAX_REQUESTS;
  wire.use(utMetadata(torrent.torrentFile));
  wire.on('error', () => peer.destroy());
  peer.on('error', () => wire.destroy());
  const cleanup = () => { for (const read of reads.values()) read.stream?.destroy(); reads.clear(); wire.destroy(); };
  peer.once('close', cleanup);
  peer.once('disconnect', cleanup);
  wire.on('handshake', infoHash => {
    if (infoHash !== torrent.infoHash) return peer.destroy();
    wire.handshake(torrent.infoHash, Buffer.concat([Buffer.from('-CS0001-'), randomBytes(12)]), { fast: true });
    const bits = Buffer.alloc(Math.ceil(torrent.pieces.length / 8), 255);
    if (torrent.pieces.length % 8) bits[bits.length - 1] = (255 << (8 - torrent.pieces.length % 8)) & 255;
    wire.bitfield(bits);
  });
  wire.on('interested', () => wire.unchoke());
  wire.on('cancel', (piece, offset, length) => {
    const read = reads.get(`${piece}:${offset}:${length}`);
    if (!read) return;
    // bittorrent-protocol drops the earliest matching request, so only its reply is owed no more.
    read.callbacks.shift();
    if (!read.callbacks.length) { read.cancelled = true; read.stream?.destroy(); }
  });
  wire.on('request', (piece, offset, length, callback) => {
    const start = piece * torrent.pieceLength + offset;
    const pieceSize = Math.min(torrent.pieceLength, torrent.length - piece * torrent.pieceLength);
    if (!Number.isInteger(piece) || !Number.isInteger(offset) || !Number.isInteger(length) || piece < 0 || offset < 0 || length < 1 || length > 128 * 1024 || offset + length > pieceSize) {
      callback(new Error('Invalid block request.')); return;
    }
    const key = `${piece}:${offset}:${length}`;
    const pending = reads.get(key);
    // bittorrent-protocol matches replies to identical requests by arrival order and drops both when one is
    // answered out of turn, so a repeated request joins the read already in flight.
    if (pending) { pending.callbacks.push(callback); return; }
    if (reads.size >= MAX_REQUESTS) { callback(new Error('Too many block requests.')); return; }
    readAhead(piece);
    /** @type {{ stream: import('node:stream').Readable | null, cancelled: boolean, callbacks: ((error: Error | null, block?: Buffer) => void)[] }} */
    const read = { stream: null, cancelled: false, callbacks: [callback] };
    reads.set(key, read);
    void (async () => {
      const chunks = [];
      let total = 0;
      for (const file of torrent.files) {
        const from = Math.max(start, file.offset);
        const to = Math.min(start + length, file.offset + file.length);
        if (to <= from || read.cancelled || peer.destroyed) continue;
        // WebTorrent treats end=0 as absent and would select the whole file; a one-byte slice reads two bytes instead.
        read.stream = file.createReadStream({ start: from - file.offset, end: to - file.offset - 1 || Math.min(1, file.length - 1) });
        let remaining = to - from;
        for await (const chunk of read.stream) {
          const bounded = chunk.subarray(0, remaining);
          chunks.push(bounded); total += bounded.length; remaining -= bounded.length;
          if (!remaining) break;
        }
      }
      if (read.cancelled || peer.destroyed) return;
      if (total !== length) throw new Error('Incomplete torrent block.');
      return Buffer.concat(chunks, length);
    })().then(block => { if (block) for (const respond of read.callbacks) respond(null, block); },
      error => { if (!read.cancelled && !peer.destroyed) for (const respond of read.callbacks) respond(error); })
      .finally(() => reads.delete(key));
  });
  peer.pipe(wire).pipe(peer);
  return wire;
}
