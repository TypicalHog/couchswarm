import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import Peer from '@thaunknown/simple-peer';
import { markSparse, torrentPathIssue, torrentSource, videoSpanFiles } from './torrent-helper.mjs';
import { serveTorrentPeer } from './remote-wire.mjs';
import { MAX_HELPER_PEERS } from './constants.mjs';

// Pieces kept selected past recent requests: enough to pipeline the swarm fetch, far short of a whole movie. A browser
// reads at its playhead and backfills from the start of the file at the same time, so a few regions stay selected.
const READ_AHEAD_BYTES = 32 * 1024 * 1024;
const READ_AHEAD_WINDOWS = 4;
const describe = error => error?.code === 'ENOSPC' ? 'The download drive is full.' : `The torrent connection failed${error?.code ? ` (${error.code})` : ''}.`;

export function createRemoteAgent({ cacheRoot, keepDownloads = false, report = () => {}, pollMs = 2000, readAheadBytes = READ_AHEAD_BYTES,
  createClient = () => new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false, ...(process.env.COUCHSWARM_HELPER_OFFLINE === '1' ? { dht: false, tracker: false } : {}) }),
  iceOverride }) {
  let grant, origin, client, torrent, directory, mediaVersion = -1, timer, closed = false, loading, loadedSource = '', swept = false;
  let status = 'Waiting for a pairing link.', lastContact = 0, previousStatus;
  let desiredVersion = -2, loadAbort, attemptedVersion = -2, attempts = 0, readyAt = 0, misses = 0, generation = 0;
  let servedPieces = { from: 0, to: -1 };
  const peers = new Map();
  const root = path.resolve(cacheRoot);
  const notify = message => { status = message; report({ status, peers: peers.size, torrentPeers: torrent?.numPeers || 0 }); };
  async function api(body) {
    const response = await fetch(`${origin}/api/helper`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(grant ? { Authorization: `Bearer ${grant.token}` } : {}) },
      body: JSON.stringify({ ...body, ...(grant ? { id: grant.id } : {}) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The launcher window renders this verbatim, so a hostile origin gets neither a multi-line alarm block nor a
      // sentence that reads as the app speaking.
      const said = typeof data.error === 'string' ? data.error.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      const error = new Error(said ? `The room website says: ${said}` : 'The website could not be reached.');
      error.status = response.status; throw error;
    }
    return data;
  }
  async function clearTorrent() {
    for (const peer of peers.values()) peer.destroy();
    peers.clear();
    torrent = undefined;
    const previousClient = client, previousDirectory = directory;
    client = undefined;
    directory = undefined;
    if (previousClient && !previousClient.destroyed) await new Promise(resolve => previousClient.destroy(resolve));
    if (!keepDownloads && previousDirectory && path.dirname(previousDirectory) === root) await rm(previousDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
  // A later poll sees the room's version differ from desiredVersion and loads again.
  function scheduleRetry() {
    const version = attemptedVersion;
    setTimeout(() => { if (!closed && desiredVersion === version) desiredVersion = -2; }, 15000).unref();
  }
  // Keep bounded runs of pieces past recent requests selected, so the swarm fetch pipelines instead of stopping after
  // each piece a browser asks for. A request past the middle of its window slides that window forward; one outside every
  // window opens another, retiring the oldest. The request's own stream selection has higher priority and stays first.
  function readAhead(value, piece, windows) {
    if (value !== torrent || value.destroyed) return;
    const span = Math.ceil(readAheadBytes / value.pieceLength);
    const index = windows.findIndex(window => piece >= window.from && piece <= window.to);
    if (index >= 0 && piece <= windows[index].from + span / 2) return;
    const stale = index >= 0 ? windows.splice(index, 1)[0] : windows.length >= READ_AHEAD_WINDOWS ? windows.shift() : null;
    if (stale) value.deselect(stale.from, stale.to);
    const window = { from: piece, to: Math.min(servedPieces.to, piece + span) };
    windows.push(window);
    value.select(window.from, window.to, 0);
  }
  async function load(room, signal) {
    // A destroyed torrent serves nobody, so a same-source switch reloads it instead of keeping it.
    if (torrent && !torrent.destroyed && room.source === loadedSource) { mediaVersion = room.mediaVersion; return; }
    const own = ++generation;
    await clearTorrent();
    if (closed || signal.aborted) return;
    mediaVersion = room.mediaVersion;
    if (!room.source) { notify('Connected. Choose a movie in your room.'); return; }
    notify('Finding torrent peers…');
    const source = await torrentSource(room.source, signal);
    if (closed || signal.aborted) return;
    let created;
    try {
      await mkdir(root, { recursive: true });
      // Kept downloads are the user's to keep, so nothing under the root is ours to sweep or name.
      if (!swept && !keepDownloads) {
        swept = true;
        for (const name of await readdir(root).catch(() => [])) {
          // The root can be a folder the user picked, so only mkdtemp's own room-XXXXXX directories qualify.
          if (!/^room-.{6}$/.test(name)) continue;
          const stale = path.join(root, name);
          const info = await stat(stale).catch(() => null);
          if (!info || !info.isDirectory() || Date.now() - info.mtimeMs <= 3600000) continue;
          if (!await stat(path.join(stale, '.couchswarm')).catch(() => null)) continue;
          await rm(stale, { recursive: true, force: true }).catch(() => {});
        }
      }
      // A host-chosen torrent controls its own relative paths, so kept downloads get their own
      // directory instead of writing straight into the folder the user picked.
      created = keepDownloads ? path.join(root, `torrent-${source.infoHash}`) : await mkdtemp(path.join(root, 'room-'));
      if (keepDownloads) await mkdir(created, { recursive: true });
      // The sweep above only deletes directories carrying this marker, so a user folder named room-abc123 is safe.
      if (!keepDownloads) await (await open(path.join(created, '.couchswarm'), 'w')).close();
    } catch (error) {
      // The room must never see a local filesystem path; the launcher window still does.
      report({ status: error.message, peers: peers.size, torrentPeers: 0 });
      throw new Error('The helper cannot write to its download folder. Stop sharing, then choose another folder in the helper.');
    }
    directory = created;
    if (closed || signal.aborted) return;
    client = createClient();
    const currentClient = client;
    const value = client.add(source, { path: directory, strategy: 'sequential', deselect: true, destroyStoreOnDestroy: !keepDownloads });
    let cause;
    // A torrent that already served the room is reloaded rather than abandoned: disk and swarm errors are usually transient.
    // Identity, not this load's signal: a same-source version bump aborts the controller while its torrent keeps serving.
    const failed = error => {
      if (closed || client !== currentClient || torrent !== value) return;
      console.error('Torrent failed:', error?.stack || error || 'closed without an error');
      if (Date.now() - readyAt > 300000) attempts = 0;
      void clearTorrent().then(() => {
        if (closed || generation !== own) return; // a newer load owns the status now
        if (attempts < 3) { notify(`${describe(error)} Reconnecting…`); scheduleRetry(); } else notify(`${describe(error)} Choose the movie again in the room to retry.`);
      }).catch(() => { if (!closed && generation === own) notify('Torrent stopped. Close the helper before clearing its temporary cache.'); });
    };
    client.on('error', error => { cause = error; failed(error); });
    value.on('error', error => { cause = error; failed(error); });
    // A client failure closes the torrent before reporting why, so let that report land first.
    value.on('close', () => queueMicrotask(() => failed(cause)));
    await new Promise((resolve, reject) => {
      let timeout = setTimeout(() => reject(new Error('No torrent metadata arrived. Check that this torrent has online seeders.')), 90000);
      const finish = error => { clearTimeout(timeout); signal.removeEventListener('abort', stopped); value.off('metadata', found); value.off('ready', ready); value.off('error', finish); value.off('close', stopped); if (error) reject(error); else resolve(); };
      // Checking a kept download against its hashes can outlast the discovery budget, so it gets its own.
      const found = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => reject(new Error('Checking the movie files on disk took too long.')), 600000);
        if (!signal.aborted) notify('Checking the movie files on disk…');
      };
      const ready = () => finish();
      const stopped = () => queueMicrotask(() => finish(new Error(cause ? describe(cause) : 'Torrent stopped.')));
      value.once('metadata', found); value.once('ready', ready); value.once('error', finish); value.once('close', stopped);
      signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted) stopped();
      if (value.ready) ready();
    });
    if (closed || signal.aborted) return;
    const issue = torrentPathIssue(value, directory);
    if (issue) throw new Error(issue);
    await markSparse(value, signal);
    if (closed || signal.aborted) return;
    if (value.destroyed) throw new Error(describe(cause));
    // Serve and prefetch only the pieces the video span covers: torrentPathIssue and markSparse validate that span
    // alone, so a write outside it lands in an unchecked, non-sparse file. An empty span leaves nothing to serve.
    const spanned = videoSpanFiles(value), last = spanned[spanned.length - 1];
    servedPieces = spanned.length ? { from: Math.floor(spanned[0].offset / value.pieceLength), to: Math.floor((last.offset + last.length - 1) / value.pieceLength) } : { from: 0, to: -1 };
    torrent = value;
    loadedSource = room.source;
    readyAt = Date.now();
    notify('Ready. Keep this helper open while everyone watches.');
  }
  async function poll() {
    if (closed) return;
    try {
      const data = await api({ action: 'poll', mediaVersion, infoHash: torrent?.infoHash || '', status });
      if (closed) return;
      lastContact = Date.now();
      misses = 0;
      if (status === 'Reconnecting to the room…') { notify(previousStatus ?? (torrent ? 'Ready. Keep this helper open while everyone watches.' : 'Connected. Finding your movie…')); previousStatus = undefined; }
      if (data.room.mediaVersion !== desiredVersion) {
        if (data.room.mediaVersion !== attemptedVersion) { attemptedVersion = data.room.mediaVersion; attempts = 0; }
        attempts++;
        desiredVersion = data.room.mediaVersion;
        loadAbort?.abort();
        const controller = loadAbort = new AbortController();
        const previous = loading;
        loading = (async () => {
          await previous;
          if (closed || controller.signal.aborted) return;
          await load(data.room, controller.signal);
        })().catch(async error => {
          await clearTorrent();
          if (closed || controller.signal.aborted) return;
          const retry = attempts < 3 && !/public internet addresses|magnet or HTTPS|Choose another torrent/.test(error.message);
          // Filesystem errors carry local paths, which the room must never see.
          const message = error.code ? describe(error) : error.message;
          notify(retry ? `${message} Retrying…` : `${message} Choose the movie again in the room to retry.`);
          if (retry) scheduleRetry();
        });
      }
      const live = new Set(data.peers.map(peer => peer.id));
      for (const [id, peer] of peers) if (!live.has(id) || data.room.mediaVersion !== mediaVersion) { peers.delete(id); peer.destroy(); }
      if (torrent && data.room.mediaVersion === mediaVersion) {
        for (const remote of data.peers) {
          if (remote.answered || peers.has(remote.id) || peers.size >= MAX_HELPER_PEERS) continue;
          // The native WebRTC polyfill assembles TURN URLs from these fields.
          const iceServers = (iceOverride ?? data.iceServers).map(server => ({ ...server,
            ...(server.username ? { username: encodeURIComponent(server.username), credential: encodeURIComponent(server.credential) } : {}),
          }));
          const peer = new Peer({ initiator: false, trickle: false, config: { iceServers } });
          // simple-peer holds a non-trickle answer until it sees the null end-of-candidates event, which the native
          // polyfill never sends — it reports the end of gathering as a state change — so every viewer would wait out
          // the library's 5 s fallback timer. Its own handler is assigned to onicegatheringstatechange, hence the
          // listener; the timer stays as the fallback for gathering that never completes.
          peer._pc?.addEventListener('icegatheringstatechange', () => {
            if (peer._pc.iceGatheringState !== 'complete' || peer._iceComplete) return;
            peer._iceComplete = true;
            peer.emit('_iceComplete');
          });
          peers.set(remote.id, peer);
          const timeout = setTimeout(() => peer.destroy(), 45000);
          peer.on('error', () => {});
          // Each viewer keeps its own read-ahead windows; a shared list lets one viewer evict another's prefetch.
          let served; const own = [];
          const disconnected = () => { clearTimeout(timeout); if (peers.get(remote.id) === peer) peers.delete(remote.id);
            if (served && !served.destroyed) for (const window of own.splice(0)) served.deselect(window.from, window.to); };
          peer.once('close', disconnected); peer.once('disconnect', disconnected);
          peer.once('connect', () => {
            clearTimeout(timeout);
            served = torrent;
            if (served && !closed) serveTorrentPeer(peer, served, piece => readAhead(served, piece, own), servedPieces); else peer.destroy();
          });
          peer.on('signal', answer => { void api({ action: 'answer', peerId: remote.id, answer }).catch(() => peer.destroy()); });
          peer.signal(remote.offer);
        }
      }
      report({ status, peers: peers.size, torrentPeers: torrent?.numPeers || 0, relayAvailable: data.relayAvailable });
    } catch (error) {
      if (closed) return;
      if (error.status === 403 || error.status === 410) { notify(error.message); await stop(false); report({ status: error.message, stopped: true }); return; }
      if (Date.now() - lastContact > 30000) { for (const peer of peers.values()) peer.destroy(); peers.clear(); }
      if (status !== 'Reconnecting to the room…') previousStatus = status;
      notify('Reconnecting to the room…');
      misses++;
    }
    // A site outage must not be retried at full cadence by every paired helper.
    if (!closed) timer = setTimeout(() => poll().catch(() => {}), Math.min(pollMs * 2 ** Math.min(misses, 4), 30000));
  }
  async function stop(inform = true) {
    closed = true; clearTimeout(timer);
    loadAbort?.abort();
    const notification = inform && grant ? api({ action: 'stop' }).catch(() => {}) : Promise.resolve();
    await clearTorrent();
    await loading;
    await clearTorrent();
    await notification;
    grant = undefined;
  }
  return {
    async pair(link) {
      const url = new URL(link.trim());
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS CouchSwarm pairing link.');
      if (url.username || url.password) throw new Error('Invalid pairing link.');
      const code = new URLSearchParams(url.hash.slice(1)).get('helper');
      if (!code || !/^[a-f0-9]{64}$/.test(code)) throw new Error('Copy a new pairing link from your CouchSwarm room.');
      origin = url.origin;
      // Naming the origin the helper is about to obey; safe here only because polling has not started, so this
      // status never reaches a room.
      notify(`Connecting to ${url.host}…`);
      grant = await api({ action: 'claim', code });
      lastContact = Date.now();
      notify('Helper paired.');
      poll().catch(() => {});
      return { roomId: grant.roomId };
    }, stop,
  };
}
