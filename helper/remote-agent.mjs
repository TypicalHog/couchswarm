import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import Peer from '@thaunknown/simple-peer';
import { markSparse, servedRanges, torrentPathIssue, torrentSource } from './torrent-helper.mjs';
import { serveTorrentPeer } from './remote-wire.mjs';
import { MAX_HELPER_PEERS } from './constants.mjs';

// Pieces kept selected past recent requests: enough to pipeline the swarm fetch, far short of a whole movie. A browser
// reads at its playhead and backfills from the start of the file at the same time, so a few regions stay selected.
const READ_AHEAD_BYTES = 32 * 1024 * 1024;
const READ_AHEAD_WINDOWS = 4;
// What the swarm may take of the host's uplink while anyone is watching. webtorrent unchokes every interested wire
// and keeps ten uncapped upload slots, which on a home connection is enough to drain a friend's buffer; the viewers'
// own wires are not in the client's throttle groups, so this reaches torrent peers only.
const SWARM_UPLOAD_WHILE_SERVING = 256 * 1024;
const describe = error => error?.code === 'ENOSPC' ? 'The download drive is full.' : `The torrent connection failed${error?.code ? ` (${error.code})` : ''}.`;

// The native WebRTC polyfill assembles TURN URLs from these fields, and libjuice percent-decodes the userinfo it
// finds there: a TURN REST username loses everything past its colon, and a base64 credential its '+', '/' and '='.
export const nativeIceServers = servers => servers.map(server => ({ ...server,
  ...(server.username ? { username: encodeURIComponent(server.username), credential: encodeURIComponent(server.credential) } : {}),
}));

// An offer is written by a room member and relayed to the helper untouched, so its candidate lines choose the
// addresses this machine then sends STUN checks to. Loopback, the unspecified address, link-local and the cloud
// metadata address are nothing a guest can be reached at, and the count is capped so one offer cannot fan out.
// Private addresses stay: a guest on the same LAN needs them when no relay is configured.
const MAX_OFFER_CANDIDATES = 20;
const unreachable = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16]]) unreachable.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fe80::', 10]]) unreachable.addSubnet(address, prefix, 'ipv6');
const cleanOffer = offer => {
  let kept = 0;
  return { ...offer, sdp: offer.sdp.split(/\r?\n/).filter(line => {
    if (!line.startsWith('a=candidate:')) return true;
    const address = line.split(' ')[4] || '';
    const family = isIP(address);
    if (family && unreachable.check(address, family === 6 ? 'ipv6' : 'ipv4')) return false;
    return ++kept <= MAX_OFFER_CANDIDATES;
  }).join('\r\n') };
};

export function createRemoteAgent({ cacheRoot, keepDownloads = false, report = () => {}, pollMs = 2000, readAheadBytes = READ_AHEAD_BYTES, retryMs = 15000,
  createClient = () => new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false, ...(process.env.COUCHSWARM_HELPER_OFFLINE === '1' ? { dht: false, tracker: false } : {}) }),
  iceOverride }) {
  let grant, origin, site = '', client, torrent, directory, mediaVersion = -1, timer, closed = false, loading, loadedSource = '', swept = false;
  let status = 'Waiting for a pairing link.', problem = false, lastContact = 0, previousStatus, previousProblem = false;
  let desiredVersion = -2, loadAbort, attemptedVersion = -2, attempts = 0, readyAt = 0, misses = 0, generation = 0, loadingSource = null, throttled = false;
  let servedPieces = [];
  const peers = new Map();
  // Every serving viewer's read-ahead windows, so a deselect can put back what the others still claim.
  const viewers = new Set();
  const root = path.resolve(cacheRoot);
  // Counted once the channel is actually open: an offer that will never connect sits in the map until its 45 s
  // timer, and the launcher would call that a viewer for the whole attempt, then again on every retry.
  const connectedPeers = () => [...peers.values()].filter(peer => peer.connected).length;
  // A status the user has to clear themselves — an unwritable folder, a full drive, retries exhausted — is flagged
  // so the launcher can colour its dot, and the flag stays with the status until the next one replaces it, since
  // every later report repeats the text.
  // The site travels with the status so the launcher can keep naming whoever is driving this helper. It goes to
  // the launcher only: the status text itself is sent to the room on every poll.
  const notify = (message, isProblem = false) => { status = message; problem = isProblem; report({ status, site, peers: connectedPeers(), torrentPeers: torrent?.numPeers || 0, ...(problem ? { problem } : {}) }); };
  async function api(body) {
    let response;
    try {
      response = await fetch(`${origin}/api/helper`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(grant ? { Authorization: `Bearer ${grant.token}` } : {}) },
        body: JSON.stringify({ ...body, ...(grant ? { id: grant.id } : {}) }), signal: AbortSignal.timeout(15000) });
    } catch (error) {
      // A refused connection, an unknown host and an intercepted certificate all reject with the same two words,
      // and the reason only lives on .cause; the launcher's log is fed from stderr, so name it there too.
      const code = error?.cause?.code || error?.name || '';
      console.error('Room website request failed:', code, error?.cause?.message || error?.message || '');
      const { host } = new URL(origin);
      throw new Error(/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)
        ? `Could not verify the certificate for ${host}. Antivirus HTTPS scanning or a company network may be intercepting the connection.`
        : code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' ? `${host} did not answer in time. Try again.`
        : `Could not reach ${host}. Check your internet connection and any firewall blocking CouchSwarm Helper.`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The launcher window renders this verbatim, so a hostile origin gets neither a multi-line alarm block nor a
      // sentence that reads as the app speaking.
      const said = typeof data.error === 'string' ? data.error.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      const error = new Error(said ? `The room website says: ${said}` : 'The website could not be reached.');
      error.status = response.status;
      // The room API explains every refusal it sends, so a 403 or 410 with no message came from a firewall or proxy
      // in front of it and must not retire the pairing.
      error.revoked = !!said && (response.status === 403 || response.status === 410);
      throw error;
    }
    return data;
  }
  async function clearTorrent() {
    for (const peer of peers.values()) peer.destroy();
    peers.clear();
    torrent = undefined;
    const previousClient = client, previousDirectory = directory;
    client = undefined;
    throttled = false;
    directory = undefined;
    if (previousClient && !previousClient.destroyed) await new Promise(resolve => previousClient.destroy(resolve));
    // Reports whether the temporary cache really went: a directory something still holds open is the one case the
    // caller has advice for, and it is the only step here that can fail.
    if (!keepDownloads && previousDirectory && path.dirname(previousDirectory) === root)
      return rm(previousDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).then(() => true, () => false);
    return true;
  }
  // A later poll sees the room's version differ from desiredVersion and loads again.
  function scheduleRetry() {
    const version = attemptedVersion;
    setTimeout(() => { if (!closed && desiredVersion === version) desiredVersion = -2; }, retryMs).unref();
  }
  // webtorrent merges overlapping non-stream selections into one range, so deselecting a window drops whatever another
  // viewer's overlapping window claimed too. Re-selecting every live window afterwards is idempotent — the merge
  // absorbs a range that is already selected — so only the pieces nobody is waiting for are left behind.
  function reassert(value) {
    if (value !== torrent || value.destroyed) return;
    for (const windows of viewers) for (const window of windows) value.select(window.from, window.to, 0);
  }
  // Keep bounded runs of pieces past recent requests selected, so the swarm fetch pipelines instead of stopping after
  // each piece a browser asks for. A request past the middle of its window slides that window forward; one outside every
  // window opens another, retiring the oldest. The request's own stream selection has higher priority and stays first.
  function readAhead(value, piece, windows) {
    if (value !== torrent || value.destroyed) return;
    // Prefetch stays inside the run the request landed in: the video's pieces and a subtitle's are separate runs,
    // and the gap between them holds files nothing validated.
    const served = servedPieces.find(range => piece >= range.from && piece <= range.to);
    if (!served) return;
    const span = Math.ceil(readAheadBytes / value.pieceLength);
    const index = windows.findIndex(window => piece >= window.from && piece <= window.to);
    if (index >= 0 && piece <= windows[index].from + span / 2) return;
    const stale = index >= 0 ? windows.splice(index, 1)[0] : windows.length >= READ_AHEAD_WINDOWS ? windows.shift() : null;
    if (stale) { value.deselect(stale.from, stale.to); reassert(value); }
    const window = { from: piece, to: Math.min(served.to, piece + span) };
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
    // Past this point the load owns the torrent it is fetching, so a pick inside that same torrent can ride along.
    loadingSource = room.source;
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
      report({ status: error.message, peers: connectedPeers(), torrentPeers: 0 });
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
      void clearTorrent().then(cleared => {
        if (closed || generation !== own) return; // a newer load owns the status now
        if (!cleared) notify('Torrent stopped. Close the helper before clearing its temporary cache.', true);
        else if (attempts < 3) { notify(`${describe(error)} Reconnecting…`, true); scheduleRetry(); } else notify(`${describe(error)} Choose the movie again in the room to retry.`, true);
      });
    };
    client.on('error', error => { cause = error; failed(error); });
    value.on('error', error => { cause = error; failed(error); });
    // A client failure closes the torrent before reporting why, so let that report land first.
    value.on('close', () => queueMicrotask(() => failed(cause)));
    await new Promise((resolve, reject) => {
      let timeout = setTimeout(() => reject(new Error('No torrent metadata arrived. Check that this torrent has online seeders.')), 90000);
      // Checking a kept download against its hashes can outlast the discovery budget, so it gets its own, and every
      // piece that verifies re-arms it: a slow drive still working through the movie has to be waited for, not given
      // up on and then hashed from piece 0 again by each retry.
      const rearm = () => { clearTimeout(timeout); timeout = setTimeout(() => reject(new Error('Checking the movie files on disk took too long.')), 600000); };
      const finish = error => { clearTimeout(timeout); signal.removeEventListener('abort', stopped); value.off('metadata', found); value.off('ready', ready); value.off('error', finish); value.off('close', stopped); value.off('verified', rearm); if (error) reject(error); else resolve(); };
      const found = () => {
        // The hash check that starts the moment this handler returns reads every file, and fs-chunk-store makes a
        // file's parent folder before it reads it, so the paths have to be judged now: a kept download would
        // otherwise be left holding a folder Windows itself cannot remove. WebTorrent stops here when the torrent
        // is gone, and finish() runs first so the 'close' it causes is not reported as a torrent that stopped.
        const issue = torrentPathIssue(value, directory);
        if (issue) { finish(new Error(issue)); value.destroy(); return; }
        rearm();
        value.on('verified', rearm);
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
    await markSparse(value, signal);
    if (closed || signal.aborted) return;
    if (value.destroyed) throw new Error(describe(cause));
    // Serve and prefetch only the video's own pieces and each subtitle's: torrentPathIssue and markSparse validate
    // every file those pieces carry, so a read outside them would download and write a file nothing checked. A
    // torrent with no video leaves nothing to serve.
    servedPieces = servedRanges(value);
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
      if (status === 'Reconnecting to the room…') { notify(previousStatus ?? (torrent ? 'Ready. Keep this helper open while everyone watches.' : 'Connected. Finding your movie…'), previousProblem); previousStatus = undefined; previousProblem = false; }
      if (data.room.mediaVersion !== desiredVersion) {
        if (data.room.mediaVersion !== attemptedVersion) { attemptedVersion = data.room.mediaVersion; attempts = 0; }
        attempts++;
        desiredVersion = data.room.mediaVersion;
        // Picking another video only changes which file of the torrent the room plays, so a pick during a load rides
        // along with it rather than destroying the client and starting the metadata fetch or hash check over.
        if (loadingSource === data.room.source) mediaVersion = data.room.mediaVersion;
        else {
          loadingSource = null;
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
            notify(retry ? `${message} Retrying…` : `${message} Choose the movie again in the room to retry.`, true);
            if (retry) scheduleRetry();
          }).finally(() => { if (loadAbort === controller) loadingSource = null; });
        }
      }
      const live = new Set(data.peers.map(peer => peer.id));
      for (const [id, peer] of peers) if (!live.has(id) || data.room.mediaVersion !== mediaVersion) { peers.delete(id); peer.destroy(); }
      if (torrent && data.room.mediaVersion === mediaVersion) {
        for (const remote of data.peers) {
          if (remote.answered || peers.has(remote.id) || peers.size >= MAX_HELPER_PEERS) continue;
          const peer = new Peer({ initiator: false, trickle: false, config: { iceServers: nativeIceServers(iceOverride ?? data.iceServers) } });
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
            viewers.delete(own);
            if (served && !served.destroyed) { for (const window of own.splice(0)) served.deselect(window.from, window.to); reassert(served); } };
          peer.once('close', disconnected); peer.once('disconnect', disconnected);
          peer.once('connect', () => {
            clearTimeout(timeout);
            served = torrent;
            if (served && !closed) { viewers.add(own); serveTorrentPeer(peer, served, piece => readAhead(served, piece, own), servedPieces); } else peer.destroy();
            // The count only moves here, so say so now rather than at the next poll.
            report({ status, peers: connectedPeers(), torrentPeers: torrent?.numPeers || 0, ...(problem ? { problem } : {}) });
          });
          peer.on('signal', answer => { void api({ action: 'answer', peerId: remote.id, answer }).catch(() => peer.destroy()); });
          peer.signal(cleanOffer(remote.offer));
        }
      }
      // Watching friends and the swarm share one uplink, so the swarm gives way while anyone is connected and gets
      // it all back when nobody is.
      const serving = connectedPeers() > 0;
      if (client && serving !== throttled) { client.throttleUpload(serving ? SWARM_UPLOAD_WHILE_SERVING : -1); throttled = serving; }
      report({ status, peers: connectedPeers(), torrentPeers: torrent?.numPeers || 0, ...(problem ? { problem } : {}), relayAvailable: data.relayAvailable });
    } catch (error) {
      if (closed) return;
      if (error.revoked) { notify(error.message); await stop(false); report({ status: error.message, stopped: true }); return; }
      if (Date.now() - lastContact > 30000) { for (const peer of peers.values()) peer.destroy(); peers.clear(); }
      if (status !== 'Reconnecting to the room…') { previousStatus = status; previousProblem = problem; }
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
      let url;
      // Without this the two messages below are never reached: a link pasted without its scheme, or with chat text
      // around it, leaves the launcher showing the two words 'Invalid URL'.
      try { url = new URL(link.trim()); } catch { throw new Error('Copy the whole pairing link from your CouchSwarm room. It starts with https://.'); }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use an HTTPS CouchSwarm pairing link.');
      if (url.username || url.password) throw new Error('Invalid pairing link.');
      const code = new URLSearchParams(url.hash.slice(1)).get('helper');
      if (!code || !/^[a-f0-9]{64}$/.test(code)) throw new Error('Copy a new pairing link from your CouchSwarm room.');
      origin = url.origin;
      site = url.host;
      // A pairing link is spent the moment it is claimed, so a folder on a drive that is not plugged in has to be
      // caught here: found at load time instead, it leaves the user needing a fresh link from the room before they
      // can even try another folder. The load still checks, because a drive can go away mid-session.
      try {
        await mkdir(root, { recursive: true });
        await rm(await mkdtemp(path.join(root, '.couchswarm-probe-')), { recursive: true, force: true });
      } catch {
        throw new Error('The helper cannot write to this download folder. Plug in its drive or choose another folder with Browse.');
      }
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
