import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import WebTorrent from 'webtorrent';
import Peer from '@thaunknown/simple-peer';
import { torrentPathIssue, torrentSource, videoSpanFiles } from './torrent-helper.mjs';
import { serveTorrentPeer } from './remote-wire.mjs';
import { MAX_SEATS } from './constants.mjs';

const run = promisify(execFile);
// Pieces kept selected past recent requests: enough to pipeline the swarm fetch, far short of a whole movie. A browser
// reads at its playhead and backfills from the start of the file at the same time, so a few regions stay selected.
const READ_AHEAD_BYTES = 32 * 1024 * 1024;
const READ_AHEAD_WINDOWS = 4;
const describe = error => error?.code === 'ENOSPC' ? 'The download drive is full.' : `The torrent connection failed${error?.code ? ` (${error.code})` : ''}.`;

export function createRemoteAgent({ cacheRoot, keepDownloads = false, report = () => {}, pollMs = 2000,
  createClient = () => new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false, ...(process.env.COUCHSWARM_HELPER_OFFLINE === '1' ? { dht: false, tracker: false } : {}) }),
  iceOverride }) {
  let grant, origin, client, torrent, directory, mediaVersion = -1, timer, closed = false, loading, loadedSource = '', swept = false;
  let status = 'Waiting for a pairing link.', lastContact = 0, previousStatus;
  let desiredVersion = -2, loadAbort, attemptedVersion = -2, attempts = 0, readyAt = 0;
  const peers = new Map();
  const windows = [];
  const root = path.resolve(cacheRoot);
  const notify = message => { status = message; report({ status, peers: peers.size, torrentPeers: torrent?.numPeers || 0 }); };
  async function api(body) {
    const response = await fetch(`${origin}/api/helper`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(grant ? { Authorization: `Bearer ${grant.token}` } : {}) },
      body: JSON.stringify({ ...body, ...(grant ? { id: grant.id } : {}) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'The website could not be reached.'); error.status = response.status; throw error; }
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
  // NTFS zero-fills everything below a write, so the tail pieces an MKV player reads first would allocate the
  // whole movie at once and can fill the drive. A sparse file only allocates the pieces that arrive.
  async function markSparse(value, signal) {
    if (process.platform !== 'win32') return;
    let store = value.store;
    while (store && !Array.isArray(store.files)) store = store.store;
    const wanted = new Set(videoSpanFiles(value));
    for (const [index, file] of value.files.entries()) {
      if (signal.aborted) return;
      const target = store?.files[index];
      if (!target || !wanted.has(file) || file.length <= value.pieceLength) continue;
      try {
        await mkdir(path.dirname(target.path), { recursive: true });
        await (await open(target.path, 'a')).close();
        await run('fsutil', ['sparse', 'setflag', target.path], { windowsHide: true, timeout: 5000, signal });
      } catch (error) { console.error('Sparse flag failed:', error.message); }
    }
  }
  // Keep bounded runs of pieces past recent requests selected, so the swarm fetch pipelines instead of stopping after
  // each piece a browser asks for. A request past the middle of its window slides that window forward; one outside every
  // window opens another, retiring the oldest. The request's own stream selection has higher priority and stays first.
  function readAhead(value, piece) {
    if (value !== torrent || value.destroyed) return;
    const span = Math.ceil(READ_AHEAD_BYTES / value.pieceLength);
    const index = windows.findIndex(window => piece >= window.from && piece <= window.to);
    if (index >= 0 && piece <= windows[index].from + span / 2) return;
    const stale = index >= 0 ? windows.splice(index, 1)[0] : windows.length >= READ_AHEAD_WINDOWS ? windows.shift() : null;
    if (stale) value.deselect(stale.from, stale.to);
    const window = { from: piece, to: Math.min(value.pieces.length - 1, piece + span) };
    windows.push(window);
    value.select(window.from, window.to, 0);
  }
  async function load(room, signal) {
    if (torrent && room.source === loadedSource) { mediaVersion = room.mediaVersion; return; }
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
      // Kept downloads live in the root itself, so nothing there is ours to sweep or name.
      if (!swept && !keepDownloads) {
        swept = true;
        for (const name of await readdir(root).catch(() => [])) {
          // The root can be a folder the user picked, so only mkdtemp's own room-XXXXXX directories qualify.
          if (!/^room-.{6}$/.test(name)) continue;
          const stale = path.join(root, name);
          const info = await stat(stale).catch(() => null);
          if (!info || !info.isDirectory() || Date.now() - info.mtimeMs <= 3600000) continue;
          await rm(stale, { recursive: true, force: true }).catch(() => {});
        }
      }
      created = keepDownloads ? root : await mkdtemp(path.join(root, 'room-'));
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
    const failed = error => {
      if (closed || signal.aborted || client !== currentClient || torrent !== value) return;
      console.error('Torrent failed:', error?.stack || error || 'closed without an error');
      if (Date.now() - readyAt > 300000) attempts = 0;
      void clearTorrent().then(() => {
        if (closed || signal.aborted) return;
        if (attempts < 3) { notify(`${describe(error)} Reconnecting…`); scheduleRetry(); } else notify(`${describe(error)} Choose the movie again in the room to retry.`);
      }).catch(() => { if (!closed && !signal.aborted) notify('Torrent stopped. Close the helper before clearing its temporary cache.'); });
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
    const issue = torrentPathIssue(value);
    if (issue) throw new Error(issue);
    await markSparse(value, signal);
    if (closed || signal.aborted) return;
    if (value.destroyed) throw new Error(describe(cause));
    torrent = value;
    loadedSource = room.source;
    readyAt = Date.now();
    windows.length = 0;
    notify('Ready. Keep this helper open while everyone watches.');
  }
  async function poll() {
    if (closed) return;
    try {
      const data = await api({ action: 'poll', mediaVersion, infoHash: torrent?.infoHash || '', status });
      if (closed) return;
      lastContact = Date.now();
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
          if (remote.answered || peers.has(remote.id) || peers.size >= MAX_SEATS) continue;
          // The native WebRTC polyfill assembles TURN URLs from these fields.
          const iceServers = (iceOverride ?? data.iceServers).map(server => ({ ...server,
            ...(server.username ? { username: encodeURIComponent(server.username), credential: encodeURIComponent(server.credential) } : {}),
          }));
          const peer = new Peer({ initiator: false, trickle: false, config: { iceServers } });
          peers.set(remote.id, peer);
          const timeout = setTimeout(() => peer.destroy(), 45000);
          peer.on('error', () => {});
          const disconnected = () => { clearTimeout(timeout); if (peers.get(remote.id) === peer) peers.delete(remote.id); };
          peer.once('close', disconnected); peer.once('disconnect', disconnected);
          peer.once('connect', () => {
            clearTimeout(timeout);
            const served = torrent;
            if (served && !closed) serveTorrentPeer(peer, served, piece => readAhead(served, piece)); else peer.destroy();
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
    }
    if (!closed) timer = setTimeout(() => poll().catch(() => {}), pollMs);
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
      notify('Connecting to your room…');
      grant = await api({ action: 'claim', code });
      lastContact = Date.now();
      notify('Helper paired.');
      poll().catch(() => {});
      return { roomId: grant.roomId };
    }, stop,
  };
}
