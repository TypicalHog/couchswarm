import { randomBytes } from 'node:crypto';
import Wire from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';

// Outstanding block requests per viewer: 256 x 16 KiB keeps 4 MiB in flight, enough for a distant guest.
const MAX_REQUESTS = 256;
// A block may be up to 128 KiB, so the count alone does not bound memory.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// WebTorrent only repeats an outstanding request when a reservation is hotswapped back to this wire; a
// viewer that stacks more than this is flooding, not streaming.
const MAX_DUPLICATES = 8;
// An answered block waits in the wire's readable side until the congested channel takes it, and queuedBytes is
// released the moment it is pushed, so the reply backlog is what actually grows. A viewer reading its channel
// never stacks more than the 4 MiB it may have in flight; 16 MiB unsent is a client requesting faster than it reads.
const MAX_UNSENT_BYTES = 16 * 1024 * 1024;

// A block waiting on a piece the torrent has not verified yet used to open its own WebTorrent read stream, and each
// of those parks a stream selection: 256 per viewer across a full room is thousands of them, while every select,
// deselect and garbage-collection pass walks that whole list. Wait on the piece instead — the first waiter selects it
// and marks it critical, one 'verified' listener serves every waiter on the torrent, and the last one to leave puts
// the selection back. Resolves false when the read ended first, so a cancelled block stops holding the piece.
/** @type {WeakMap<object, Map<number, Set<(verified: boolean) => void>>>} */
const waiting = new WeakMap();
function whenVerified(torrent, piece, stopped) {
  let pieces = waiting.get(torrent);
  if (!pieces) {
    waiting.set(torrent, pieces = new Map());
    torrent.on('verified', index => { for (const settle of pieces.get(index) ?? []) settle(true); });
  }
  let waiters = pieces.get(piece);
  if (!waiters) {
    // The priority and shape WebTorrent's own read streams ask with, so the swarm fetches the piece a viewer is
    // blocked on before the read-ahead window trailing it.
    torrent._select(piece, piece, 1, null, true);
    torrent.critical(piece, piece);
    pieces.set(piece, waiters = new Set());
  }
  return new Promise(resolve => {
    const settle = verified => {
      if (!waiters.delete(settle)) return;
      if (!waiters.size) { pieces.delete(piece); if (!torrent.destroyed) torrent._deselect(piece, piece, true); }
      resolve(verified);
    };
    waiters.add(settle);
    void stopped.then(() => settle(false));
  });
}

// Advertise availability to our authenticated room only. Each requested block
// is fetched and verified by the native torrent before the browser receives it.
export function serveTorrentPeer(peer, torrent, readAhead = () => {}, pieces = null) {
  const wire = new Wire();
  const reads = new Map();
  let queuedBytes = 0;
  let armed = false;
  wire.extendedHandshake.reqq = MAX_REQUESTS;
  wire.on('error', () => peer.destroy());
  peer.on('error', () => wire.destroy());
  const cleanup = () => { for (const read of reads.values()) read.stop(); reads.clear(); wire.destroy(); };
  peer.once('close', cleanup);
  peer.once('disconnect', cleanup);
  // bittorrent-protocol's _pull() removes the first Request matching (piece, offset, length), not the one that owns
  // this callback, so a queued duplicate must be moved to the front or its reply is silently dropped.
  const answer = (read, error, block, piece, offset, length) => {
    for (const respond of read.callbacks) {
      const i = wire.peerRequests.findIndex(request => request.callback === respond);
      // respond(error) rejects, and reject() pulls a second matching Request: a duplicate can lose its entry
      // without a message, so send the reject that entry was owed.
      if (i < 0) { if (error && wire.hasFast) wire.reject(piece, offset, length); continue; }
      if (i) [wire.peerRequests[0], wire.peerRequests[i]] = [wire.peerRequests[i], wire.peerRequests[0]];
      respond(error, block);
    }
  };
  wire.on('handshake', infoHash => {
    if (infoHash !== torrent.infoHash) { peer.destroy(); return; }
    armed = true;
    // Armed only now, so a wrong infohash is never served the info dict; must precede handshake(), which sends the
    // extended handshake built from extendedMapping straight away.
    wire.use(utMetadata(torrent.torrentFile));
    wire.handshake(torrent.infoHash, Buffer.concat([Buffer.from('-CS0001-'), randomBytes(12)]), { fast: true });
    // Advertise only what the guard below will answer: a browser told this peer holds a piece it will always refuse
    // re-asks for it until the room gives up on the file, which is how a subtitle past the video used to fail.
    const bits = Buffer.alloc(Math.ceil(torrent.pieces.length / 8));
    for (let piece = 0; piece < torrent.pieces.length; piece++)
      if (!pieces || pieces.some(range => piece >= range.from && piece <= range.to)) bits[piece >> 3] |= 128 >> (piece % 8);
    wire.bitfield(bits);
  });
  // peer.destroy() is deferred, so a rejected peer keeps parsing the same message: staying choked is what stops it.
  wire.on('interested', () => { if (armed) wire.unchoke(); });
  wire.on('cancel', (piece, offset, length) => {
    const read = reads.get(`${piece}:${offset}:${length}`);
    if (!read) return;
    // bittorrent-protocol has already dropped one matching request, and that removal is unordered, so the reply it
    // ends is not necessarily the first callback's: forget the callback whose entry is the one that went.
    const gone = read.callbacks.findIndex(respond => !wire.peerRequests.some(request => request.callback === respond));
    read.callbacks.splice(gone < 0 ? 0 : gone, 1);
    if (!read.callbacks.length) { read.cancelled = true; read.stop(); }
  });
  wire.on('request', (piece, offset, length, callback) => {
    // A refusal would leave the backlog in place, so a peer that stopped draining its replies has to go.
    if (wire._readableState.buffered + queuedBytes > MAX_UNSENT_BYTES) { peer.destroy(); return; }
    const pieceSize = Math.min(torrent.pieceLength, torrent.length - piece * torrent.pieceLength);
    // A piece nothing serves belongs to a file nothing validated or marked sparse, and reading it here is
    // what makes the torrent download and write it.
    if (!Number.isInteger(piece) || !Number.isInteger(offset) || !Number.isInteger(length) || piece < 0 || offset < 0 || length < 1 || length > 128 * 1024 || offset + length > pieceSize || (pieces && !pieces.some(range => piece >= range.from && piece <= range.to))) {
      callback(new Error('Invalid block request.')); return;
    }
    const key = `${piece}:${offset}:${length}`;
    const pending = reads.get(key);
    // A repeated request joins the read already in flight, but never a cancelled one: its replies are no longer sent,
    // so the duplicate would be black-holed instead of starting its own read.
    if (pending && !pending.cancelled) {
      // A refusal cannot drain bittorrent-protocol's peerRequests for a duplicate, so the channel has to go.
      if (pending.callbacks.length >= MAX_DUPLICATES) { peer.destroy(); return; }
      pending.callbacks.push(callback); return;
    }
    if (reads.size >= MAX_REQUESTS || queuedBytes + length > MAX_REQUEST_BYTES) { callback(new Error('Too many block requests.')); return; }
    queuedBytes += length;
    readAhead(piece);
    // A read waiting on a piece the torrent has not verified yet is never settled from this side: WebTorrent
    // resolves that wait only from a 'verified' event, so a cancelled block — or a viewer whose channel closed —
    // would hold its bytes and its entry here until some unrelated piece happens to arrive. Race the wait against
    // the channel instead; ending the read releases its share of the piece with it.
    let stop = () => {};
    const stopped = new Promise(resolve => { stop = () => resolve(null); });
    /** @type {{ stop: () => void, cancelled: boolean, callbacks: ((error: Error | null, block?: Buffer) => void)[] }} */
    const read = { stop, cancelled: false, callbacks: [callback] };
    reads.set(key, read);
    void (async () => {
      // The guard above keeps a block inside one piece, and the bitfield is set only once that piece has been
      // written and verified, so whatever it holds is already in the store — no read stream, and no selection.
      if (!torrent.bitfield.get(piece) && !await whenVerified(torrent, piece, stopped)) return;
      if (read.cancelled || peer.destroyed) return;
      return await new Promise((resolve, reject) =>
        torrent.store.get(piece, { offset, length }, (error, block) => error ? reject(error) : resolve(block)));
    })().then(block => { if (block) answer(read, null, block, piece, offset, length); },
      error => { if (!read.cancelled && !peer.destroyed) answer(read, error, undefined, piece, offset, length); })
      .finally(() => { queuedBytes -= length; if (reads.get(key) === read) reads.delete(key); });
  });
  peer.pipe(wire).pipe(peer);
  // A browser peer only sends control messages (handshake, interested, request, cancel, have, bitfield);
  // anything that cannot be framed inside 256 KiB is a flood, not a message.
  peer.on('data', () => { if (wire._bufferSize > 256 * 1024) peer.destroy(); });
  // ut_metadata answers each request with up to 16 KiB through the same readable buffer and keeps no byte account
  // of its own; the event fires once the extension has queued its reply, so the backlog is caught there too.
  wire.on('extended', () => { if (wire._readableState.buffered > MAX_UNSENT_BYTES) peer.destroy(); });
  return wire;
}
