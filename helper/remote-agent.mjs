import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import Peer from '@thaunknown/simple-peer';
import { torrentPathIssue, torrentSource } from './torrent-helper.mjs';
import { serveTorrentPeer } from './remote-wire.mjs';
import { MAX_SEATS } from './constants.mjs';

export function createRemoteAgent({ cacheRoot, keepDownloads = false, report = () => {}, pollMs = 2000,
  createClient = () => new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false, ...(process.env.COUCHSWARM_HELPER_OFFLINE === '1' ? { dht: false, tracker: false } : {}) }),
  iceOverride }) {
  let grant, origin, client, torrent, directory, mediaVersion = -1, timer, closed = false, loading, loadedSource = '', swept = false;
  let status = 'Waiting for a pairing link.', lastContact = 0, previousStatus;
  let desiredVersion = -2, loadAbort, attemptedVersion = -2, attempts = 0;
  const peers = new Map();
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
    const failed = () => {
      if (closed || signal.aborted || client !== currentClient) return;
      void clearTorrent().then(() => {
        if (!closed && !signal.aborted) notify('The torrent connection failed. Choose another movie or stop and pair again to retry.');
      }).catch(() => { if (!closed && !signal.aborted) notify('Torrent stopped. Close the helper before clearing its temporary cache.'); });
    };
    client.on('error', failed);
    const value = client.add(source, { path: directory, strategy: 'sequential', deselect: true, destroyStoreOnDestroy: !keepDownloads });
    value.on('error', () => { if (torrent === value) failed(); });
    value.on('close', () => { if (torrent === value) failed(); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No torrent metadata arrived. Check that this torrent has online seeders.')), 90000);
      const finish = error => { clearTimeout(timeout); signal.removeEventListener('abort', stopped); value.off('ready', ready); value.off('error', finish); value.off('close', stopped); if (error) reject(error); else resolve(); };
      const ready = () => finish();
      const stopped = () => finish(new Error('Torrent stopped.'));
      value.once('ready', ready); value.once('error', finish); value.once('close', stopped);
      signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted) stopped();
      if (value.ready) ready();
    });
    if (closed || signal.aborted) return;
    const issue = torrentPathIssue(value);
    if (issue) throw new Error(issue);
    torrent = value;
    loadedSource = room.source;
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
          notify(retry ? `${error.message} Retrying…` : `${error.message} Choose the movie again in the room to retry.`);
          if (retry) { const version = attemptedVersion; setTimeout(() => { if (!closed && desiredVersion === version) desiredVersion = -2; }, 15000).unref(); }
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
          peer.once('connect', () => { clearTimeout(timeout); if (torrent && !closed) serveTorrentPeer(peer, torrent); else peer.destroy(); });
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
