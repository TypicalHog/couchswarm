import { randomBytes } from 'node:crypto';
import Wire from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';

// Advertise availability to our authenticated room only. Each requested block
// is fetched and verified by the native torrent before the browser receives it.
export function serveTorrentPeer(peer, torrent) {
  const wire = new Wire();
  const reads = new Map();
  wire.extendedHandshake.reqq = 32;
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
    if (read) { read.cancelled = true; read.stream?.destroy(); }
  });
  wire.on('request', (piece, offset, length, callback) => {
    const start = piece * torrent.pieceLength + offset;
    const pieceSize = Math.min(torrent.pieceLength, torrent.length - piece * torrent.pieceLength);
    if (!Number.isInteger(piece) || !Number.isInteger(offset) || !Number.isInteger(length) || piece < 0 || offset < 0 || length < 1 || length > 128 * 1024 || offset + length > pieceSize || reads.size >= 32) {
      callback(new Error('Invalid block request.')); return;
    }
    const key = `${piece}:${offset}:${length}`;
    if (reads.has(key)) { callback(new Error('Duplicate block.')); return; }
    /** @type {{ stream: import('node:stream').Readable | null, cancelled: boolean }} */
    const read = { stream: null, cancelled: false };
    reads.set(key, read);
    void (async () => {
      const chunks = [];
      let total = 0;
      for (const file of torrent.files) {
        const from = Math.max(start, file.offset);
        const to = Math.min(start + length, file.offset + file.length);
        if (to <= from || read.cancelled || peer.destroyed) continue;
        read.stream = file.createReadStream({ start: from - file.offset, end: to - file.offset - 1 });
        let remaining = to - from;
        for await (const chunk of read.stream) {
          const bounded = chunk.subarray(0, remaining);
          chunks.push(bounded); total += bounded.length; remaining -= bounded.length;
          if (!remaining) break;
        }
      }
      if (!read.cancelled && !peer.destroyed) {
        if (total !== length) throw new Error('Incomplete torrent block.');
        callback(null, Buffer.concat(chunks, length));
      }
    })().catch(error => { if (!read.cancelled && !peer.destroyed) callback(error); }).finally(() => reads.delete(key));
  });
  peer.pipe(wire).pipe(peer);
  return wire;
}
