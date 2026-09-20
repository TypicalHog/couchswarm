import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { get } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';
import rangeParser from 'range-parser';
import { MAX_ROOM_TORRENTS, MAX_SEATS } from './constants.mjs';

const PREFIX = '/torrent-helper';
const ROUTE = new RegExp(`^${PREFIX}/(sessions|metadata|seed)/([a-f0-9]{64})(?:/(.*))?$`);
const run = promisify(execFile);
// A room holds MAX_SEATS people and the helper serves MAX_ROOM_TORRENTS rooms, so no honest
// caller can need more leases than this; the cap only ever rejects abuse.
const MAX_SESSIONS = MAX_ROOM_TORRENTS * MAX_SEATS;
// A torrent past this is an archive, not a movie: hashing it costs minutes here and freezes every viewer's
// tab for seconds. Mirrored by the browser's own check in hooks/use-torrent.ts.
const MAX_TORRENT_FILES = 20000;
// The dev server builds one helper per loopback origin; they share a cache root.
let swept = false;
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['192.0.0.0', 24],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 96], ['::1', 128], ['2002::', 16], ['2001::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');
// A translating prefix carries a real IPv4 in the low 32 bits, and says nothing itself about where that
// address lives: judging the carrier refuses every public host a DNS64 resolver synthesises, and still
// lets 10.0.0.5 through a local-use translator. So decode these and judge what they carry.
const translating = new BlockList();
// RFC 6052 well-known, RFC 8215 local-use, and the RFC 2765 IPv4-translated form.
for (const [address, prefix] of [['64:ff9b::', 96], ['64:ff9b:1::', 48], ['::ffff:0:0:0', 96]]) translating.addSubnet(address, prefix, 'ipv6');
const embeddedAddress = value => {
  if (!translating.check(value, 'ipv6')) return '';
  const tail = value.slice(value.lastIndexOf(':') + 1);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  // The last two groups hold the address; either can be elided, which reads as zero.
  const groups = value.split(':');
  const low = parseInt(groups.pop() || '0', 16), high = parseInt(groups.pop() || '0', 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};
export const publicAddress = address => {
  const carried = isIP(address) === 6 ? embeddedAddress(address.toLowerCase()) : '';
  return carried ? !blocked.check(carried, 'ipv4') : !blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
};
// A name is not an address: resolve it here the way fetchTorrent does, or `localhost` and
// `127.0.0.1.nip.io` walk straight past the filter below.
const publicHost = async value => {
  const host = value.replace(/^\[|\]$/g, '');
  if (isIP(host)) return publicAddress(host);
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.length > 0 && addresses.every(({ address }) => publicAddress(address));
};

// A source the helper refuses outright. The agent retries a failed load three times, so a refusal that a second
// attempt would reach the same way says so here rather than leaving the agent to guess from the wording.
const refusal = message => Object.assign(new Error(message), { permanent: true });

async function fetchTorrent(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !publicAddress(hostname)) throw refusal('Torrent URLs must use public internet addresses. Choose another torrent.');
  return new Promise((resolve, reject) => {
    const request = get(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      lookup(host, options, callback) {
        lookup(host, { all: true }).then(addresses => {
          if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw refusal('Torrent URLs must use public internet addresses. Choose another torrent.');
          // Pin the checked addresses into this connection to prevent DNS rebinding.
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }).catch(callback);
      },
    }, async response => {
      try {
        const status = response.statusCode ?? 0;
        // Redirects are not followed, so the address checked above stays the one this connection uses.
        if (status >= 300 && status < 400) throw refusal('The torrent URL must return the file directly, without a redirect. Choose another torrent.');
        // A server that is briefly down can answer the next attempt; everything else already said its final word.
        if (status !== 200) throw Object.assign(new Error(`The torrent URL returned HTTP ${status}. Check that the link still works.`), { permanent: status < 500 });
        resolve(await readLimited(response, 4 * 1024 * 1024, 'That .torrent file is larger than 4 MiB. Choose another torrent.'));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on('error', reject);
  });
}
// The room shares one fileIndex, so the tie-break compares code units rather than the viewer's locale.
// parse-torrent joins a nested path with the platform separator, so compare the shape the site sees or
// 'Pack\A.mkv' and 'Pack/A.mkv' sort to opposite sides of 'PackA.mkv'.
const slashed = file => file.path.replaceAll('\\', '/');
export const videoFiles = files => files.filter(file => /\.(mkv|mp4|webm|m4v|ogv)$/i.test(file.name))
  .sort((a, b) => b.length - a.length || (slashed(a) < slashed(b) ? -1 : slashed(a) > slashed(b) ? 1 : 0));

// Keep this list in step with lib/subtitles.ts, which offers the same extensions in the picker.
const subtitleName = /\.(srt|ass|ssa|vtt)$/i;
const filesIn = (torrent, ranges) => torrent.files.filter(file => ranges.some(range =>
  file.offset < (range.to + 1) * torrent.pieceLength && file.offset + file.length > range.from * torrent.pieceLength));

// The pieces a viewer may ask for: the video's own run first, then one per subtitle, so a sidecar the picker lists
// past the video still arrives. The video run stops at the video's last piece rather than at the last byte of the
// file sharing that piece, or read-ahead would reach into whatever follows.
export function servedRanges(torrent) {
  const videos = videoFiles(torrent.files);
  if (!videos.length) return [];
  const range = (from, to) => ({ from: Math.floor(from / torrent.pieceLength), to: Math.floor((to - 1) / torrent.pieceLength) });
  // A torrent can list more files than a spread can carry as arguments, so walk them instead.
  let first = Infinity, last = 0;
  for (const file of videos) { first = Math.min(first, file.offset); last = Math.max(last, file.offset + file.length); }
  return [range(first, last), ...torrent.files.filter(file => file.length && subtitleName.test(file.name))
    .map(file => range(file.offset, file.offset + file.length))];
}

// The files a viewer can ask for: whatever shares a piece with the video, plus the subtitles the picker offers.
export function servedFiles(torrent) {
  const [video] = servedRanges(torrent);
  const span = new Set(video ? filesIn(torrent, [video]) : []);
  return torrent.files.filter(file => span.has(file) || subtitleName.test(file.name));
}

// Every file the helper is ever allowed to write. A piece reaches the disk whole, so a subtitle's own piece brings
// its neighbours with it: torrentPathIssue and markSparse cover exactly this set, so a piece the helper serves can
// never write a name nothing validated into a file nothing flagged sparse.
export function writtenFiles(torrent) {
  return filesIn(torrent, servedRanges(torrent));
}

// NTFS zero-fills everything below a write, so the tail pieces an MKV player reads first would allocate the
// whole movie at once and can fill the drive. A sparse file only allocates the pieces that arrive.
export async function markSparse(value, signal) {
  if (process.platform !== 'win32') return;
  let store = value.store;
  while (store && !Array.isArray(store.files)) store = store.store;
  const wanted = new Set(writtenFiles(value));
  for (const [index, file] of value.files.entries()) {
    if (signal?.aborted) return;
    const target = store?.files[index];
    if (!target || !wanted.has(file) || file.length <= value.pieceLength) continue;
    try {
      await mkdir(path.dirname(target.path), { recursive: true });
      await (await open(target.path, 'a')).close();
      await run('fsutil', ['sparse', 'setflag', target.path], { windowsHide: true, timeout: 5000, signal });
    } catch (error) { console.error('Sparse flag failed:', error.message); }
  }
}

// Win32 reads a device name up to the first '.' and ignores trailing spaces, so 'nul .mkv' is the NUL
// device as well, and CONIN$, CONOUT$ and the superscript COM¹ forms are devices an ASCII list misses.
const deviceName = part => /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(part.split('.')[0].replace(/ +$/, ''));

// fs-chunk-store sanitises only the file name, Windows folds case and treats a
// backslash inside a name as a separator, and WebTorrent puts the raw path in
// web seed URLs.
export function torrentPathIssue(torrent, root = '') {
  const seen = new Set();
  // fs-chunk-store makes a file's parent folder before it so much as reads it, and the startup hash check reads every
  // file, so the folders of files the helper never serves are created too. A kept download is then left holding a
  // folder like 'aux' that Explorer, cmd and PowerShell all refuse to remove.
  for (const file of torrent.files)
    if (slashed(file).split('/').slice(0, -1).some(part => /[<>:"|?*\p{Cc}]/u.test(part) || deviceName(part) || /[. ]$/.test(part)))
      return 'This torrent has a folder name Windows cannot create. Choose another torrent.';
  for (const file of writtenFiles(torrent)) {
    const parts = file.path.replaceAll('\\', '/').split('/');
    if (parts.slice(0, -1).some(part => /[<>:"|?*\p{Cc}]/u.test(part))) return 'This torrent has a folder name Windows cannot create. Choose another torrent.';
    // fs-chunk-store strips these characters from the file name, so 'nul?.mkv' reaches the disk as
    // 'nul.mkv': every check below reads the name that is stored, not the one the torrent declares.
    const name = parts[parts.length - 1].replace(/[<>:"/\\|?*\p{Cc}]/gu, '');
    if (!name) return 'This torrent has a folder name Windows cannot create. Choose another torrent.';
    const stored = [...parts.slice(0, -1), name];
    // Win32 reroutes NUL.mkv as well as NUL, and folds away a trailing dot or space, so Node writes an
    // entry through \\?\ that nothing else on the machine can open, list or delete.
    if (stored.some(part => deviceName(part) || /[. ]$/.test(part))) return 'This torrent has a folder name Windows cannot create. Choose another torrent.';
    // fsutil and every Win32 tool still stop at MAX_PATH, so a deep torrent in a deep folder is not writable sparse.
    if (root && path.join(root, ...stored).length > 250) return 'This torrent stores its files too deep for your download folder. Choose another torrent or a shorter folder.';
    if (torrent.files.length > 1 && (/[#?%\p{Cc}]/u.test(file.path) || file.path.endsWith(' ')))
      return 'This multi-file torrent has a filename WebTorrent cannot request as a web seed path. Choose another torrent.';
    // Folded a code point at a time: lowercasing the whole string applies Unicode's word-final rule, so a Σ before
    // '/' or a space becomes ς while the same word spelled with σ does not, and NTFS stores the two as one file.
    const key = Array.from(stored.join('/'), character => character.toLowerCase()).join('');
    if (seen.has(key)) return 'This torrent has two files that Windows would store under the same name. Choose another torrent.';
    seen.add(key);
  }
  return '';
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readLimited(stream, limit, message = 'Request is too large.') {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw refusal(message);
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
    if (url.protocol !== 'https:' || url.username || url.password || !/\.torrent$/i.test(url.pathname)) throw refusal('Use a magnet or HTTPS .torrent URL.');
    const bytes = await fetchTorrent(url, signal);
    // A login page or an empty body reaches the parser, whose own text names a bencode delimiter or a null read.
    try { parsed = await parseTorrent(bytes); }
    catch (error) { console.error('Torrent parse failed:', error.message); throw refusal('That link did not return a valid .torrent file. Choose another torrent.'); }
  }
  // This helper retrieves data from torrent peers. Do not let metadata URLs,
  // web seeds, trackers or peer hints turn it into an arbitrary HTTP/file proxy
  // on the host computer or a probe of its private network.
  delete parsed.xs;
  delete parsed.as;
  parsed.urlList = [];
  if (process.env.COUCHSWARM_HELPER_OFFLINE !== '1') {
    // A BEP9 hint is ip:port, and a name resolved here cannot be pinned to WebTorrent's later connect.
    parsed.peerAddresses = (parsed.peerAddresses || []).filter(peer => {
      let hint; try { hint = decodeURIComponent(peer); } catch { hint = peer; }
      const host = hint.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      return !!isIP(host) && publicAddress(host);
    });
    // http/https announces are excluded because undici follows redirects, which would re-point the
    // announce at any address after this filter has run.
    // dns.lookup takes neither a signal nor a timeout, so cap the list and bound the whole phase: a magnet
    // listing hundreds of trackers otherwise holds a source switch and stop() open for as long as it resolves.
    // Whatever has not answered by then drops, the same fail-closed answer publicHost gives a lookup error.
    const trackers = (parsed.announce || []).slice(0, 64);
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    // Each answer lands where it belongs as it arrives, so one name whose nameservers never reply takes
    // only itself down; waiting on the whole list would throw away the trackers that already passed.
    const allowed = trackers.map(() => '');
    if (!deadline.aborted) {
      const checks = Promise.all(trackers.map(async (tracker, index) => {
        const url = URL.parse(tracker);
        // ws: is dropped outright: the socket carries the announce URL's own path and Host as a plain HTTP
        // request, and bittorrent-tracker resolves the name again at announce, so a rebinding answer aims
        // that request at whatever it then points to. wss: survives because TLS fails before the rebind lands.
        if (!url || !['udp:', 'wss:'].includes(url.protocol)) return;
        if (url.protocol === 'wss:') { if (await publicHost(url.hostname)) allowed[index] = tracker; return; }
        // dgram resolves the name at announce too, so pin the address checked here into the URL itself.
        const { address, family } = await lookup(url.hostname.replace(/^\[|\]$/g, '')).catch(() => ({}));
        if (address && publicAddress(address))
          allowed[index] = `udp://${family === 6 ? `[${address}]` : address}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}`;
      }));
      await Promise.race([checks, new Promise(resolve => deadline.addEventListener('abort', resolve, { once: true }))]);
    }
    parsed.announce = allowed.filter(Boolean);
  }
  return parsed;
}

// The source filter above only sees the addresses the source names. Trackers, the DHT and ut_pex hand
// WebTorrent peers of their own, and its one connect-time filter reads client.blocked, which stays unset
// unless a blocklist is passed. The suites seed from 127.0.0.1, so offline mode keeps every address.
export function filterPeers(client) {
  if (process.env.COUCHSWARM_HELPER_OFFLINE !== '1')
    client.blocked = { contains: host => !isIP(host) || !publicAddress(host) };
  return client;
}

export function createTorrentHelper({ siteOrigin, cacheRoot, idleMs = 120000, graceMs = 60000,
  createClient = () => filterPeers(new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, utp: false,
    ...(process.env.COUCHSWARM_HELPER_OFFLINE === '1' ? { dht: false, tracker: false }
      : { tracker: { announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'] } }) })) }) {
  const origin = new URL(siteOrigin).origin;
  const root = path.resolve(cacheRoot);
  const entries = new Map();
  const sessions = new Map();
  const cleanups = new Set();
  let closed = false;

  async function dispose(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    // markSparse recreates the files it flags, so stop it before the rm below or it leaves a markerless
    // session directory the sweep will never reclaim.
    entry.abort.abort();
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
      const parsed = await torrentSource(source, entry.abort.signal);
      if (entry.disposed) return;
      await mkdir(root, { recursive: true });
      if (!swept) {
        swept = true;
        for (const name of await readdir(root).catch(() => [])) {
          if (!name.startsWith('session-')) continue;
          const stale = path.join(root, name);
          if ([...entries.values()].some(other => other.directory === stale)) continue;
          // The marker is what a live helper keeps fresh; writes inside a session folder leave its own mtime alone,
          // so judging the folder would reclaim another helper's movie while it is still playing.
          const marker = await stat(path.join(stale, '.couchswarm')).catch(() => null);
          if (!marker || Date.now() - marker.mtimeMs <= 3600000) continue;
          await rm(stale, { recursive: true, force: true }).catch(() => {});
        }
      }
      const directory = await mkdtemp(path.join(root, 'session-'));
      // The cache root can be a folder the user picked, so the sweep above deletes only what carries this marker.
      await (await open(path.join(directory, '.couchswarm'), 'w')).close();
      entry.directory = directory;
      if (entry.disposed) { await rm(directory, { recursive: true, force: true }); return; }
      const client = entry.client = createClient();
      const fail = message => {
        entry.error = message;
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        cleanup(entry);
      };
      client.on('error', () => fail('The helper lost its torrent connection. Reconnect to try again.'));
      const torrent = entry.torrent = client.add(parsed, { path: directory, strategy: 'sequential', deselect: true, destroyStoreOnDestroy: true }, async torrent => {
        // Nothing awaits this callback, so a throw here would be an unhandled rejection that takes the
        // whole helper down, and with it every other viewer it is serving.
        try {
          if (entry.disposed) return;
          clearTimeout(entry.timeout);
          if (!videoFiles(torrent.files).length) { fail('This torrent does not contain an MKV, MP4, WebM, M4V, or OGV video.'); return; }
          const issue = torrentPathIssue(torrent, directory);
          if (issue) { fail(issue); return; }
          // entry.ready unlocks the read endpoint, which drives the first store write, so flag the files first.
          await markSparse(torrent, entry.abort.signal);
          if (entry.disposed) return;
          entry.ready = true;
          // Reads select only the requested pieces. Avoid a full background movie
          // download when everybody already has enough buffer or leaves the room.
        } catch (error) {
          console.error('Torrent setup failed:', error);
          fail('The helper could not load this torrent.');
        }
      });
      torrent.on('error', error => fail(error?.code ? `The helper could not write its cache (${error.code}).` : 'The helper could not load this torrent. Check that it has online seeders.'));
      torrent.once('metadata', () => {
        if (entry.disposed) return;
        if (torrent.files.length > MAX_TORRENT_FILES) { fail(`This torrent has ${torrent.files.length} files; CouchSwarm handles up to ${MAX_TORRENT_FILES}. Choose another torrent.`); return; }
        // Hashing what the torrent already has on disk can outlast the discovery budget, and reporting that as
        // seeders that never arrived sends the room after a torrent that was in fact loading. It gets its own.
        clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => fail('Checking this torrent’s files took too long. Choose another torrent.'), 600000);
        entry.timeout.unref();
      });
      entry.timeout = setTimeout(() => fail('No torrent metadata arrived after 90 seconds. This torrent may have no reachable seeders.'), 90000);
      entry.timeout.unref();
    } catch (error) {
      console.error('Torrent load failed:', error);
      // Only an fs error carries .path, and its message spells out the operator's cache folder. The room
      // may be reaching a reverse-proxied helper, so it gets the code the way the torrent error path does.
      entry.error = error?.path ? `The helper could not write its cache (${error.code}).`
        : error instanceof Error ? error.message : 'The helper could not load this torrent.';
      if (entries.get(entry.key) === entry) entries.delete(entry.key);
      cleanup(entry);
    }
  }

  const sweep = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.seen > idleMs) release(id);
  }, Math.min(30000, idleMs));
  sweep.unref();
  // Another helper sharing this cache root reclaims a session folder an hour after its marker was written,
  // so keep ours current for as long as the download is held.
  const heartbeat = setInterval(() => {
    const now = new Date();
    for (const entry of entries.values())
      if (entry.directory) void utimes(path.join(entry.directory, '.couchswarm'), now, now).catch(() => {});
  }, 600000);
  heartbeat.unref();

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
          // A room watches one torrent at a time, so the budget counts rooms rather than entries: a host
          // switching source must not be refused by their own room's superseded entry, which a guest's
          // lease keeps alive until that guest's room poll remounts them onto the new source.
          const rooms = new Set([...entries.values()].map(other => other.roomId));
          if (!rooms.has(body.roomId) && rooms.size >= MAX_ROOM_TORRENTS) { json(res, 429, { error: 'The helper supports two active torrents. Leave another room first.' }); return; }
          entry = { key, roomId: body.roomId, sessions: new Set(), streams: new Set(), ready: false, disposed: false, abort: new AbortController() };
          entries.set(key, entry);
          void initialize(entry, room.source);
        }
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { entry, seen: Date.now() });
        entry.sessions.add(id);
        json(res, 201, { id, source: room.source, mediaVersion: room.mediaVersion }); return;
      }
      const match = url.pathname.match(ROUTE);
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
      const served = servedFiles(torrent);
      const file = torrent.files.length === 1 && !suffix ? served[0]
        : served.find(file => file.path.replaceAll('\\', '/') === decodeURIComponent(suffix));
      if (!file) { json(res, 404, { error: 'This file is not in the torrent.' }); return; }
      if (!file.length) {
        // WebTorrent asks for the whole piece an empty file sits in and cannot use a 416 here.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': 0, 'Cache-Control': 'no-store' });
        res.end(); return;
      }
      // RFC 9110 14.1.2: a suffix-length past the end of the file means the whole representation.
      const suffixRange = /^\s*bytes\s*=\s*-(\d+)\s*$/.exec(req.headers.range || '');
      const header = suffixRange && Number(suffixRange[1]) >= file.length ? `bytes=0-${file.length - 1}` : req.headers.range;
      let ranges = header ? rangeParser(file.length, header) : null;
      if (ranges === -1) { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); res.end(); return; }
      if (ranges && (!Array.isArray(ranges) || ranges.length !== 1 || ranges.type !== 'bytes')) ranges = null;
      const { start, end } = ranges?.[0] || { start: 0, end: file.length - 1 };
      res.writeHead(ranges ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, 'Cache-Control': 'no-store',
        ...(ranges ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) });
      if (req.method === 'HEAD') { res.end(); return; }
      // A read waiting on a piece the swarm has not sent yet cannot be called off: WebTorrent settles it only
      // from a 'verified' event, and destroying the stream neither resolves that wait nor drops its listener.
      // So race every read against the response instead. The iterator is taken directly, since a stream over
      // it would only add another handle nothing can release.
      // WebTorrent treats end=0 as absent. Limit this edge case to one byte.
      const iterator = file[Symbol.asyncIterator]({ start, end: end === 0 ? Math.min(1, file.length - 1) : end });
      // Ending the response is what frees a parked read, so that is what the entry's teardown is given.
      const reader = { destroy: () => res.destroy() };
      entry.streams.add(reader);
      const gone = new Promise(resolve => res.once('close', () => resolve(null)));
      let remaining = end - start + 1;
      async function* bounded() {
        while (remaining) {
          const next = await Promise.race([iterator.next(), gone]);
          if (!next) return;
          // FileIterator reports a chunk-store read error as a clean end, so a short read has to fail the pipeline.
          if (next.done) throw new Error('Incomplete torrent read.');
          session.seen = Date.now();
          yield next.value.subarray(0, remaining);
          remaining -= Math.min(remaining, next.value.length);
        }
      }
      res.setTimeout(60000, () => res.destroy());
      try { await pipeline(bounded(), res); } finally { void iterator.return?.(); entry.streams.delete(reader); }
    } catch {
      if (!res.headersSent) json(res, 400, { error: 'The helper request could not be completed.' });
      else res.destroy();
    }
  }

  return { handle, async close() {
    closed = true; clearInterval(sweep); clearInterval(heartbeat);
    for (const id of sessions.keys()) release(id);
    for (const entry of entries.values()) { clearTimeout(entry.idleTimer); cleanup(entry); }
    entries.clear();
    await Promise.allSettled(cleanups);
  } };
}
