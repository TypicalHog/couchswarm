import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { get } from 'node:https';
import { pipeline } from 'node:stream/promises';
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';
import rangeParser from 'range-parser';
import { MAX_ROOM_TORRENTS, MAX_SEATS } from './constants.mjs';

const PREFIX = '/torrent-helper';
// A room holds MAX_SEATS people and the helper serves MAX_ROOM_TORRENTS rooms, so no honest
// caller can need more leases than this; the cap only ever rejects abuse.
const MAX_SESSIONS = MAX_ROOM_TORRENTS * MAX_SEATS;
// The dev server builds one helper per loopback origin; they share a cache root.
let swept = false;
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 96], ['::1', 128], ['64:ff9b::', 96], ['2002::', 16], ['2001::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');
const publicAddress = address => !blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
const publicHost = value => { const host = value.replace(/^\[|\]$/g, ''); return !isIP(host) || publicAddress(host); };

async function fetchTorrent(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error('Torrent URLs must use public internet addresses.');
  return new Promise((resolve, reject) => {
    const request = get(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      lookup(host, options, callback) {
        lookup(host, { all: true }).then(addresses => {
          if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Torrent URLs must use public internet addresses.');
          // Pin the checked addresses into this connection to prevent DNS rebinding.
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }).catch(callback);
      },
    }, async response => {
      try {
        if (response.statusCode !== 200) throw new Error('The torrent URL must return the file directly, without a redirect.');
        resolve(await readLimited(response, 4 * 1024 * 1024));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on('error', reject);
  });
}
export const videoFiles = files => files.filter(file => /\.(mkv|mp4|webm|m4v|ogv)$/i.test(file.name))
  .sort((a, b) => b.length - a.length || a.path.localeCompare(b.path));

// Only files sharing a piece with a video are ever written.
export function videoSpanFiles(torrent) {
  const videos = videoFiles(torrent.files);
  if (!videos.length) return [];
  const from = Math.floor(Math.min(...videos.map(file => file.offset)) / torrent.pieceLength) * torrent.pieceLength;
  const to = Math.ceil(Math.max(...videos.map(file => file.offset + file.length)) / torrent.pieceLength) * torrent.pieceLength;
  return torrent.files.filter(file => file.offset + file.length > from && file.offset < to);
}

// fs-chunk-store sanitises only the file name, Windows folds case and treats a
// backslash inside a name as a separator, and WebTorrent puts the raw path in
// web seed URLs.
export function torrentPathIssue(torrent) {
  const seen = new Set();
  for (const file of videoSpanFiles(torrent)) {
    const parts = file.path.replaceAll('\\', '/').split('/');
    if (parts.slice(0, -1).some(part => /[<>:"|?*\p{Cc}]/u.test(part))) return 'This torrent has a folder name Windows cannot create. Choose another torrent.';
    if (torrent.files.length > 1 && (/[#?%\p{Cc}]/u.test(file.path) || file.path.endsWith(' ')))
      return 'This multi-file torrent has a filename WebTorrent cannot request as a web seed path. Choose another torrent.';
    const key = [...parts.slice(0, -1), parts[parts.length - 1].replace(/[<>:"/\\|?*\p{Cc}]/gu, '')].join('/').toLowerCase();
    if (seen.has(key)) return 'This torrent has two files that Windows would store under the same name. Choose another torrent.';
    seen.add(key);
  }
  return '';
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Request is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function torrentSource(source, signal) {
  let parsed;
  if (source.startsWith('magnet:?') && source.length <= 8192) {
    parsed = await parseTorrent(source);
  } else {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || !/\.torrent$/i.test(url.pathname)) throw new Error('Use a magnet or HTTPS .torrent URL.');
    parsed = await parseTorrent(await fetchTorrent(url, signal));
  }
  // This helper retrieves data from torrent peers. Do not let metadata URLs,
  // web seeds, trackers or peer hints turn it into an arbitrary HTTP/file proxy
  // on the host computer or a probe of its private network.
  delete parsed.xs;
  delete parsed.as;
  parsed.urlList = [];
  if (process.env.COUCHSWARM_HELPER_OFFLINE !== '1') {
    parsed.peerAddresses = (parsed.peerAddresses || []).filter(peer => {
      let hint; try { hint = decodeURIComponent(peer); } catch { hint = peer; }
      return publicHost(hint.replace(/:\d+$/, ''));
    });
    parsed.announce = (parsed.announce || []).filter(tracker => {
      const url = URL.parse(tracker);
      return !!url && ['udp:', 'http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && publicHost(url.hostname);
    });
  }
  return parsed;
}

export function createTorrentHelper({ siteOrigin, cacheRoot, idleMs = 120000, graceMs = 60000,
  createClient = () => new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false,
    tracker: { announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'] } }) }) {
  const origin = new URL(siteOrigin).origin;
  const root = path.resolve(cacheRoot);
  const entries = new Map();
  const sessions = new Map();
  const cleanups = new Set();
  let closed = false;

  async function dispose(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    clearTimeout(entry.timeout);
    for (const stream of entry.streams) stream.destroy();
    if (entry.client && !entry.client.destroyed) await new Promise(resolve => entry.client.destroy(resolve));
    if (entry.directory && path.dirname(entry.directory) === root) await rm(entry.directory, { recursive: true, force: true });
  }

  function cleanup(entry) {
    const task = dispose(entry).catch(() => {}).finally(() => cleanups.delete(task));
    cleanups.add(task);
  }

  function release(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    const entry = session.entry;
    entry.sessions.delete(id);
    if (!entry.sessions.size) {
      // Keep the cache briefly so a reconnecting viewer reuses this download.
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (entry.sessions.size) return;
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        cleanup(entry);
      }, graceMs);
      entry.idleTimer.unref();
    }
  }

  async function initialize(entry, source) {
    try {
      const parsed = await torrentSource(source);
      if (entry.disposed) return;
      await mkdir(root, { recursive: true });
      if (!swept) {
        swept = true;
        for (const name of await readdir(root).catch(() => [])) {
          if (!name.startsWith('session-')) continue;
          const stale = path.join(root, name);
          if ([...entries.values()].some(other => other.directory === stale)) continue;
          const { mtimeMs } = await stat(stale).catch(() => ({ mtimeMs: Date.now() }));
          if (Date.now() - mtimeMs > 3600000) await rm(stale, { recursive: true, force: true }).catch(() => {});
        }
      }
      const directory = await mkdtemp(path.join(root, 'session-'));
      entry.directory = directory;
      if (entry.disposed) { await rm(directory, { recursive: true, force: true }); return; }
      const client = entry.client = createClient();
      const fail = message => {
        entry.error = message;
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        cleanup(entry);
      };
      client.on('error', () => fail('The helper lost its torrent connection. Reconnect to try again.'));
      const torrent = entry.torrent = client.add(parsed, { path: directory, strategy: 'sequential', deselect: true, destroyStoreOnDestroy: true }, torrent => {
        if (entry.disposed) return;
        clearTimeout(entry.timeout);
        if (!videoFiles(torrent.files).length) { fail('This torrent does not contain an MKV, MP4, WebM, M4V, or OGV video.'); return; }
        const issue = torrentPathIssue(torrent);
        if (issue) { fail(issue); return; }
        entry.ready = true;
        // Reads select only the requested pieces. Avoid a full background movie
        // download when everybody already has enough buffer or leaves the room.
      });
      torrent.on('error', error => fail(error?.code ? `The helper could not write its cache (${error.code}).` : 'The helper could not load this torrent. Check that it has online seeders.'));
      entry.timeout = setTimeout(() => fail('No torrent metadata arrived after 90 seconds. This torrent may have no reachable seeders.'), 90000);
      entry.timeout.unref();
    } catch (error) {
      entry.error = error instanceof Error ? error.message : 'The helper could not load this torrent.';
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      cleanup(entry);
    }
  }

  const sweep = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.seen > idleMs) release(id);
  }, Math.min(30000, idleMs));
  sweep.unref();

  async function handle(req, res, next = () => json(res, 404, { error: 'Not found.' })) {
    const url = URL.parse(req.url, origin);
    if (!url) { json(res, 400, { error: 'Bad request.' }); return; }
    if (!url.pathname.startsWith(`${PREFIX}/`)) { next(); return; }
    if (closed) { json(res, 503, { error: 'The helper is stopping.' }); return; }
    // Companion endpoints are only for this local site. They are not a public
    // torrent gateway. A reverse proxy must preserve Host and Origin checks.
    if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
      json(res, 403, { error: 'Open the helper through your CouchSwarm site.' }); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (url.pathname === `${PREFIX}/health` && req.method === 'GET') {
        json(res, 200, { available: true }); return;
      }
      if (url.pathname === `${PREFIX}/sessions` && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) { json(res, 415, { error: 'Use JSON.' }); return; }
        const token = req.headers.authorization;
        if (!/^Bearer [a-f0-9]{64}$/.test(token || '')) { json(res, 401, { error: 'Join a room before using the helper.' }); return; }
        const body = JSON.parse((await readLimited(req, 1024)).toString());
        if (!/^[a-f0-9-]{36}$/.test(body.roomId || '')) { json(res, 400, { error: 'Invalid room.' }); return; }
        // Read the authoritative source from the app; callers cannot ask this
        // endpoint to download a different URL or impersonate another room.
        const response = await fetch(`${origin}/api/rooms/${body.roomId}`, {
          method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'snapshot' }), signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!response.ok) { json(res, response.status, { error: 'Your room access could not be verified.' }); return; }
        const { room } = await response.json();
        if (!room?.source) { json(res, 409, { error: 'Choose a torrent in the room first.' }); return; }
        if (closed || res.destroyed) return;
        if (sessions.size >= MAX_SESSIONS) { json(res, 429, { error: 'The helper has too many active viewers. Try again shortly.' }); return; }
        const key = `${body.roomId}:${room.source}`;
        let entry = entries.get(key);
        if (entry) clearTimeout(entry.idleTimer);
        else {
          for (const other of entries.values()) if (!other.sessions.size) { clearTimeout(other.idleTimer); entries.delete(other.key); cleanup(other); }
          if (entries.size >= MAX_ROOM_TORRENTS) { json(res, 429, { error: 'The helper supports two active torrents. Leave another room first.' }); return; }
          entry = { key, sessions: new Set(), streams: new Set(), ready: false, disposed: false };
          entries.set(key, entry);
          void initialize(entry, room.source);
        }
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { entry, seen: Date.now() });
        entry.sessions.add(id);
        json(res, 201, { id, source: room.source, mediaVersion: room.mediaVersion }); return;
      }
      const match = url.pathname.match(/^\/torrent-helper\/(sessions|metadata|seed)\/([a-f0-9]{64})(?:\/(.*))?$/);
      if (!match) { json(res, 404, { error: 'Not found.' }); return; }
      const [, action, id, suffix = ''] = match;
      const session = sessions.get(id);
      if (!session) { json(res, 410, { error: 'The helper session expired. Reconnect to the movie.' }); return; }
      if (action === 'sessions' && req.method === 'DELETE') { release(id); json(res, 200, { ok: true }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed.' }); return; }
      session.seen = Date.now();
      const entry = session.entry;
      const torrent = entry.torrent;
      if (action === 'sessions') {
        json(res, 200, { ready: entry.ready && !entry.error, error: entry.error || '', peers: torrent?.numPeers || 0,
          speed: torrent?.downloadSpeed || 0, downloaded: torrent?.downloaded || 0 }); return;
      }
      if (!entry.ready || entry.error) { json(res, 503, { error: entry.error || 'Waiting for torrent metadata.' }); return; }
      if (action === 'metadata') {
        res.writeHead(200, { 'Content-Type': 'application/x-bittorrent', 'Content-Length': torrent.torrentFile.length, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : torrent.torrentFile); return;
      }
      const file = torrent.files.length === 1 && !suffix ? torrent.files[0]
        : torrent.files.find(file => file.path.replaceAll('\\', '/') === decodeURIComponent(suffix));
      if (!file) { json(res, 404, { error: 'This file is not in the torrent.' }); return; }
      if (!file.length) {
        // WebTorrent asks for the whole piece an empty file sits in and cannot use a 416 here.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': 0, 'Cache-Control': 'no-store' });
        res.end(); return;
      }
      let ranges = req.headers.range ? rangeParser(file.length, req.headers.range) : null;
      if (ranges === -1) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); res.end(); return; }
      if (ranges && (!Array.isArray(ranges) || ranges.length !== 1 || ranges.type !== 'bytes')) ranges = null;
      const { start, end } = ranges?.[0] || { start: 0, end: file.length - 1 };
      res.writeHead(ranges ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Content-Length': Math.max(0, end - start + 1), 'Cache-Control': 'no-store',
        ...(ranges ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) });
      if (req.method === 'HEAD' || !file.length) { res.end(); return; }
      const stream = file.createReadStream({ start, end: end === 0 ? Math.min(1, file.length - 1) : end });
      entry.streams.add(stream);
      // WebTorrent treats end=0 as absent. Limit this edge case to one byte.
      let remaining = end - start + 1;
      async function* bounded() {
        for await (const chunk of stream) {
          session.seen = Date.now();
          yield chunk.subarray(0, remaining);
          remaining -= Math.min(remaining, chunk.length);
          if (!remaining) return;
        }
      }
      res.setTimeout(60000, () => res.destroy());
      const abortStream = () => stream.destroy();
      res.once('close', abortStream);
      try { await pipeline(bounded(), res); } finally {
        stream.destroy(); entry.streams.delete(stream); res.removeListener('close', abortStream);
      }
    } catch {
      if (!res.headersSent) json(res, 400, { error: 'The helper request could not be completed.' });
      else res.destroy();
    }
  }

  return { handle, async close() {
    closed = true; clearInterval(sweep);
    for (const id of sessions.keys()) release(id);
    for (const entry of entries.values()) { clearTimeout(entry.idleTimer); cleanup(entry); }
    entries.clear();
    await Promise.allSettled(cleanups);
  } };
}
