'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type WebTorrent from 'webtorrent/dist/webtorrent.min.js';
import type { Torrent, TorrentFile, TorrentFileStream } from 'webtorrent/dist/webtorrent.min.js';
import type { PlaysVideoEngine } from 'playsvideo';
import { isMkv, videoFiles } from '@/lib/video-files';
import { decodeSubtitle, subtitleFiles, toWebVTT } from '@/lib/subtitles';
import { connectHelper } from '@/lib/torrent-helper';
import { connectRemoteHelper, helperStatus } from '@/lib/remote-helper';
import type { Session } from '@/lib/sync';

// A read parks on a piece that a destroyed torrent will never deliver, and destroying the stream only releases
// the pieces it selected — streamx holds back 'close' while the read is parked — so the caller is handed the
// stream to abandon and has to settle its own wait rather than await a promise that could outlive the room.
function readFile(file: TorrentFile, hold: (stream: TorrentFileStream) => void) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    hold(file.createReadStream()
      .on('data', chunk => { chunks.push(chunk); size += chunk.length; })
      .on('end', () => {
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        resolve(bytes);
      })
      .on('error', reject)
      // Reached once an abandoned stream is free to close; after a resolve above this settles nothing.
      .on('close', () => reject(new Error('This subtitle could not be read from the torrent.'))));
  });
}

// The helper serves the torrent's own files over HTTP too, and WebTorrent builds its web seed URLs out of the
// raw torrent path: a subtitle whose path holds '#', '?' or '%' is asked for under a truncated name, answered
// 404, and — with nobody else holding the file — waits out the pick's whole budget for a file the helper has.
// Ask for it here with every path segment encoded; whatever the helper cannot answer is left to the swarm.
function readFromHelper(seedUrl: string, file: TorrentFile) {
  if (!seedUrl) return Promise.resolve(null);
  return fetch(`${seedUrl}/${file.path.split('/').map(encodeURIComponent).join('/')}`)
    .then(async response => response.ok ? new Uint8Array(await response.arrayBuffer()) : null).catch(() => null);
}

// Nothing outside the next torrent's add callback ever frees this browser's movie store, so a viewer who left
// the room kept the whole download as site data. A tab showing no movie, with no room in its address bar to
// rejoin, is the moment that store is certainly nobody's: take the same lock a stream takes — a tab still
// watching holds it — and drop every movie. Settles rather than rejects, because start() waits on it.
async function reclaimStore() {
  try {
    await navigator.locks.request('couchswarm:media', { ifAvailable: true }, async lock => {
      if (!lock) return;
      const root = await navigator.storage.getDirectory();
      for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys())
        await root.removeEntry(key, { recursive: true }).catch(() => {});
    });
  } catch { /* No lock manager or no storage: there is nothing here to reclaim. */ }
}

// A torrent past this is an archive, not a movie: verifying it takes tens of seconds and the file picker it
// lists is unusable. Mirrored by MAX_TORRENT_FILES in helper/torrent-helper.mjs.
const MAX_TORRENT_FILES = 20000;

// Whatever is picked is read whole, decoded into a string of its own and copied again, so a movie chosen by
// mistake in the upload dialog freezes the tab for seconds. No real subtitle comes near this.
const MAX_SUBTITLE_BYTES = 8_000_000;

// The pick effect and the upload check below have to accept and refuse exactly the same files, so both parse
// through here. A file the picker could not parse would otherwise attach an empty track and show nothing at
// all. A .vtt is passed through untouched, so its arrow spacing is the author's and WebVTT allows none at all:
// look for a cue timing rather than for the spaced arrow only the conversions write.
function toSubtitleCues(bytes: AllowSharedBufferSource, name: string) {
  const vtt = toWebVTT(decodeSubtitle(bytes, navigator.languages), name);
  if (!/\d{2}\.\d+[ \t]*-->/.test(vtt)) throw new Error('No subtitles could be read out of that file.');
  return vtt;
}

// Adding a torrent against a kept store re-hashes every saved piece before the movie can start again, which
// holds the whole room in buffering. Only one movie's store survives an add, so one remembered bitfield covers
// every restart this tab can make; a reload starts without one and verifies as before.
let verified: { source: string; bitfield: Uint8Array } | undefined;

export function useTorrent(source: string, fileIndex: number, mediaVersion: number, videoRef: RefObject<HTMLVideoElement | null>, session: Session | null) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [files, setFiles] = useState<{ name: string; path: string; size: number }[]>([]);
  const [subtitles, setSubtitles] = useState<{ name: string; path: string }[]>([]);
  // null is subtitles off; a number indexes the torrent's own list; a File is this participant's upload.
  const [subtitle, setSubtitle] = useState<number | File | null>(null);
  // A pick that fails leaves its own entry selected, and React drops a state update that changes nothing, so
  // choosing it again would do nothing at all. Every pick is counted, and the read runs again on the count.
  const [picked, setPicked] = useState(0);
  const [subtitleError, setSubtitleError] = useState('');
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const subtitleRef = useRef<TorrentFile[]>([]);
  // A pick that has not attached a track yet is re-run once a restarted torrent lists its files: the list it
  // indexes is emptied on every torrent effect run, and a read parked on a piece the old client will never
  // deliver cannot settle itself. A pick that already shows is left alone.
  const pendingPick = useRef(false);
  const [listed, setListed] = useState(0);
  const [stats, setStats] = useState({ speed: 0, peers: 0, progress: 0, filename: '', size: 0 });
  const [loadedVersion, setLoadedVersion] = useState(-1);
  const [helper, setHelper] = useState<{ peers?: number; host?: boolean } | null>(null);
  // A paired helper is only reported once it is connected, which is a metadata wait plus a WebRTC leg away.
  // Set while that is in flight, so nothing on screen claims the room has no helper during it.
  const [helperPending, setHelperPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fileRef = useRef<TorrentFile | null>(null);
  const retriedHelper = useRef(0);
  const retriedUpgrade = useRef(false);
  // A restart that lost its helper may adopt the returning one even though the kept store already holds bytes.
  const lostHelper = useRef(false);
  // Whether this tab is streaming from its own paired helper at this moment. The room's status says a paired
  // row exists, which a stopped or offline helper leaves behind, so it cannot answer that.
  const ownHelperLive = useRef(false);
  const movieRef = useRef('');
  const sourceRef = useRef('');
  // Where the subtitle effect, which has no torrent of its own, can see the standalone helper's seed URL.
  const seedUrlRef = useRef('');
  const teardownRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let client: WebTorrent | undefined;
    let torrent: Torrent | undefined;
    let mkvPlayer: PlaysVideoEngine | undefined;
    // Set when the MKV engine gave up and the file was handed to the video element instead.
    let mkvNative = false;
    let torrentFailed = false;
    let gotMetadata = false;
    let peerTimer: ReturnType<typeof setTimeout> | undefined;
    let helperTimer: ReturnType<typeof setTimeout> | undefined;
    let healthyTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelProbe: ReturnType<typeof setInterval> | undefined;
    let releaseLock: (() => void) | undefined;
    const abort = new AbortController();
    // Helper retry budgets are per movie, not per hook mount.
    const movie = `${source}|${mediaVersion}|${fileIndex}`;
    // A subtitle chosen for the last movie would index a file list this one does not have.
    if (movieRef.current !== movie) { movieRef.current = movie; retriedHelper.current = 0; retriedUpgrade.current = false; lostHelper.current = false; setSubtitle(null); }
    fileRef.current = null;
    subtitleRef.current = [];
    seedUrlRef.current = '';
    setLoadedVersion(-1);
    setHelper(null);
    setHelperPending(false);
    ownHelperLive.current = false;
    // The file list belongs to the torrent, not the selection: keep it across a file switch so the picker stays mounted.
    if (sourceRef.current !== source) { sourceRef.current = source; setFiles([]); setSubtitles([]); }
    setError('');
    setStats({ speed: 0, peers: 0, progress: 0, filename: '', size: 0 });
    setStatus(source ? 'Finding your movie…' : '');
    const fail = (message: string) => { if (!disposed) { setError(message); setStatus(''); } };
    // A room keeps its id in the address bar, so a tab with no movie and no room there has left one.
    if (!source && !new URLSearchParams(location.search).get('room')) teardownRef.current = reclaimStore();

    async function start() {
      if (!source || !video) return;
      // Torrent stores are keyed by info hash. A replacement must wait for the
      // old store to be destroyed before opening the same torrent again.
      await teardownRef.current;
      if (disposed) return;
      if (!window.isSecureContext) { fail('Use a current browser over HTTPS or localhost to stream torrents.'); return; }
      // A private window hides navigator.serviceWorker in Firefox before 138, and in-app browsers do much the
      // same: the browser and the connection are both current, so telling someone otherwise sends them nowhere.
      if (!('serviceWorker' in navigator)) {
        fail('This window cannot run CouchSwarm’s video service, which private windows and in-app browsers often block. Open this link in a normal browser window.'); return;
      }
      if (!('RTCPeerConnection' in window)) { fail('This browser has WebRTC turned off, and streaming needs it. Turn it on, or watch in another browser.'); return; }
      try {
        // One torrent store per browser profile: a second tab opens the same OPFS
        // directory and its teardown deletes the pieces this tab downloaded.
        // The holder is sometimes this same tab on its way out: an error boundary's reset, or any remount,
        // starts the old client's destroy and only releases the lock in its callback, so asking whether the
        // lock is free this instant would report another tab that does not exist. Wait a moment for a holder
        // that is leaving, and give up long before the viewer would.
        const locked = await new Promise<boolean>(resolve => {
          void navigator.locks.request('couchswarm:media', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]) }, () => {
            resolve(true);
            return new Promise<void>(release => { releaseLock = release; });
          }).catch(() => resolve(false));
        });
        if (!locked) { try { sessionStorage.removeItem('couchswarm:sw-reload'); } catch { /* Storage blocked: nothing to clear. */ } fail('Another CouchSwarm tab already has a movie open. Close or reload that tab, then reconnect here.'); return; }
        if (disposed) { releaseLock?.(); return; }
        // The bundle's peer id and piece hashing call Uint8Array methods that browsers we support may not have yet.
        await import('@/lib/uint8-polyfill');
        const { default: TorrentClient } = await import('webtorrent/dist/webtorrent.min.js')
          .catch(() => { throw new Error('The streaming files could not be loaded — this site may have been updated. Reload this page and rejoin.'); });
        if (disposed) return;
        const registration = await navigator.serviceWorker.register('/sw.min.js', { scope: '/' })
          .catch(() => { throw new Error('Streaming could not start: this browser blocked CouchSwarm’s video service worker. Allow site data for this site, then reload this page.'); });
        const activated = await Promise.race([
          navigator.serviceWorker.ready.then(() => true),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15000)),
        ]);
        if (!activated) throw new Error('Streaming could not start: this browser did not activate the CouchSwarm video service. Reload this page.');
        if (!navigator.serviceWorker.controller) {
          const claimed = (ms: number) => new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(false), ms);
            navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(true); }, { once: true, signal: abort.signal });
          });
          // A newly installed worker claims this page within milliseconds. Only a page still
          // uncontrolled after that was loaded under an already-active worker that never re-claims it.
          if (!(await claimed(1000)) && !disposed) {
            try {
              if (registration.active && !sessionStorage.getItem('couchswarm:sw-reload')) {
                sessionStorage.setItem('couchswarm:sw-reload', '1');
                location.reload();
                return;
              }
            } catch { /* Storage blocked: the reload cannot be marked, so wait for the claim rather than loop. */ }
            if (!(await claimed(15000))) throw new Error('Streaming could not start. Reload this page.');
          }
        }
        try { sessionStorage.removeItem('couchswarm:sw-reload'); } catch { /* Storage blocked: nothing to clear. */ }
        if (disposed) return;
        // Every tracker announce carries WebRTC offers, and with no configuration of ours the bundled
        // simple-peer reaches for its own Google and Twilio STUN: an operator who named their servers
        // would still have each viewer's address gathered by two strangers on every announce. Ask the
        // room for the same servers the helper connection uses; a failure leaves the swarm on host
        // candidates rather than on somebody else's STUN.
        let iceServers: RTCIceServer[] = [];
        if (session) {
          try {
            const status = await helperStatus(session, abort.signal);
            iceServers = status.iceServers;
            if (status.paired) setHelperPending(true);
          }
          catch { /* The room connection already reports connectivity failures. */ }
          if (disposed) return;
        }
        // Magnets often list only UDP trackers, which browsers cannot contact.
        // Shared WebSocket trackers let this client discover WebRTC seeders.
        const tracker = { announce: [
          'wss://tracker.openwebtorrent.com',
          'wss://tracker.webtorrent.dev',
        ], rtcConfig: { iceServers } };
        client = new TorrentClient({ tracker });
        client.on('error', () => fail('The torrent connection failed. Try a different torrent or reload the room.'));
        client.createServer({ controller: registration });
        // The video worker drops its 5 s pull timeout only in the instance that answered this probe, and
        // WebTorrent sends it once, from createServer. A worker the browser restarts under a live page starts
        // with the timeout back on, and a piece that then takes longer leaves the read with no data, no close
        // and no error. The worker answers the probe itself, so it never reaches the network.
        const probe = () => { void fetch('/webtorrent/cancel/').then(response => response.body?.cancel()).catch(() => {}); };
        cancelProbe = setInterval(probe, 15000);
        // A tab coming back from frozen or discarded is the likeliest moment to be talking to a new worker.
        document.addEventListener('visibilitychange', probe, { signal: abort.signal });
        document.addEventListener('resume', probe, { signal: abort.signal });
        let helperFailed = false;
        // The helper says why it could not serve this movie — not ready, no relay configured, no seeders —
        // and 'using browser peers' is the consequence, not the reason. Keep the reason on screen, and let
        // the no-data message below repeat it instead of telling the viewer to start a helper that is
        // already running.
        let helperReason = '';
        const fallBack = (err: unknown) => {
          // An expired room or a lost seat belongs to the room connection, which reports it already.
          const code = (err as { status?: number }).status;
          if (err instanceof Error && code !== 403 && code !== 410) helperReason = err.message;
          // The loopback leg has been reporting peer counts, so the side panel still claims a helper.
          setHelper(null);
          setStatus(`${helperReason || 'The helper could not be reached.'} Using browser peers…`);
          return null;
        };
        const remote = session ? await connectRemoteHelper(session, mediaVersion, abort.signal, setStatus,
          own => {
            ownHelperLive.current = false;
            if (fileRef.current?.progress === 1) return;
            setHelper(null);
            lostHelper.current = true;
            // Selection has already re-pointed at the host's helper, and a helper reloads a torrent that failed
            // after serving, so allow a few reconnects before giving up.
            if (retriedHelper.current < 3) { retriedHelper.current++; setAttempt(value => value + 1); return; }
            fail(`${own ? 'Your' : 'The host’s'} helper disconnected. Reconnect to the movie to try again.`);
          // A stale chunk is not a helper that could not be reached: it tells the viewer to reload instead of
          // spending this movie's one upgrade attempt on a browser-only stream.
          }).catch(err => { if (abort.signal.aborted || (err as { stale?: boolean }).stale) throw err; helperFailed = retriedUpgrade.current; retriedUpgrade.current = true; return fallBack(err); }) : null;
        if (remote) {
          ownHelperLive.current = remote.own;
          setHelper({ host: !remote.own });
          // The reconnect budget above is spent by every drop in one movie, so an evening of brief Wi-Fi
          // hiccups used it up and stopped the film the fourth time one landed. A leg that has stayed up this
          // long has earned it back; one that flaps inside the minute still gives up after three.
          healthyTimer = setTimeout(() => { retriedHelper.current = 0; }, 60_000);
        }
        // Cleared after the helper is reported, so the two never read false at the same moment. Every way
        // out of the attempt — connected, unpaired mid-wait, offline too long, failed — passes here.
        setHelperPending(false);
        const bridge = session && !remote ? await connectHelper(session, source, mediaVersion, abort.signal, value => {
          if (disposed) return;
          setHelper({ peers: value.peers });
          // The overlay's status is an atomic live region, so a count that changes on every one-second poll
          // reads the whole sentence out again. The count is in 'Your connection', which is read on demand.
          if (!value.ready) setStatus('Your helper is finding torrent peers…');
        // Same budget as the paired helper: a refused lease — the room's own superseded torrent still
        // holding a laggard guest, or a helper not started yet — is retried once, then offered.
        // A refusal the helper reported itself — no video file, a name it cannot store, no metadata after
        // 90 seconds — comes back with HTTP 200 and is about this torrent, not about reaching the helper,
        // so it goes to the error overlay where Reconnect and Try another torrent are.
        }).catch(err => { if (abort.signal.aborted || (err as { status?: number }).status === 200) throw err; helperFailed = retriedUpgrade.current; retriedUpgrade.current = true; return fallBack(err); }) : null;
        if (disposed) return;
        if (bridge) {
          seedUrlRef.current = bridge.seedUrl;
          let misses = 0;
          const heartbeat = async () => {
            try { await bridge.status(); misses = 0; }
            catch (err) {
              const code = (err as { status?: number }).status;
              // A timed-out poll, a dropped connection or a 5xx from the proxy in front of the helper is a
              // blip, and the paired helper's heartbeat rides out four of them before giving up. Only an
              // answer the helper gave itself ends the movie on the spot.
              if ((code === undefined || code >= 500) && ++misses < 4) {
                if (!disposed) helperTimer = setTimeout(() => void heartbeat(), 5000);
                return;
              }
              bridge.release();
              const reported = err instanceof Error && code !== undefined ? err.message : '';
              if (!disposed) fail(reported || 'The torrent helper disconnected. Reconnect to the movie to try again.');
              return;
            }
            if (!disposed) helperTimer = setTimeout(() => void heartbeat(), 5000);
          };
          helperTimer = setTimeout(() => void heartbeat(), 5000);
        }
        if (remote || bridge) lostHelper.current = false;
        if (session && !bridge && !remote?.own) {
          // A helper that becomes ready later upgrades this browser-only stream, and a guest on the host's
          // helper remounts onto their own once it is ready. The restart interrupts playback, so adopt one
          // only before any video bytes land — unless this stream lost its helper, where the kept store's
          // bytes say nothing about the swarm and the stall is worse than the interruption.
          // A helper that was offered and could not be reached is upgraded to once per movie, never in a loop:
          // once that budget is spent the returning helper is offered instead, because a tab left on browser
          // peers that receive nothing holds the whole room paused with nothing to click.
          const upgrade = (own: boolean) => {
            if (fileRef.current?.downloaded && !lostHelper.current) return;
            if (helperFailed) fail(`${own ? 'Your' : 'The host’s'} helper is available again. Reconnect to the movie to use it.`);
            else setAttempt(value => value + 1);
          };
          // A hidden tab asks a third as often, which is worth having on a phone in a pocket; what is not
          // worth having is the guest inheriting that wait when they come back to the tab.
          let pending = false;
          const arm = () => { pending = true; helperTimer = setTimeout(() => void watch(), document.hidden ? 30000 : 15000); };
          const watch = async () => {
            pending = false;
            // The helper dialog polls this same status on a timer of its own, so stop as soon as the upgrade
            // can no longer fire: once this stream has bytes there is nothing left for a second poller to do.
            if (fileRef.current?.downloaded && !lostHelper.current) return;
            try {
              const { ready, own } = await helperStatus(session, abort.signal);
              if (disposed) return;
              if (ready && (!remote || own)) { upgrade(own); return; }
              // A helper served through this site is not paired to the room, so the room API can never
              // report it: only its own health endpoint says it is there. Without this probe a refused
              // lease, or a helper started after the room, is final for the whole movie.
              if (!remote) {
                const health = await fetch('/torrent-helper/health', { signal: abort.signal })
                  .then(response => response.ok ? response.json() as Promise<{ available?: boolean }> : null).catch(() => null);
                if (disposed) return;
                if (health?.available === true) { upgrade(true); return; }
              }
            }
            catch { /* The room connection already reports connectivity failures. */ }
            if (!disposed) arm();
          };
          // Only a poll that is still pending is brought forward: every way out of watch() above leaves
          // nothing armed, so a loop that stopped on purpose is not started again by a returning guest.
          document.addEventListener('visibilitychange', () => {
            if (document.hidden || !pending) return;
            clearTimeout(helperTimer);
            void watch();
          }, { signal: abort.signal });
          arm();
        }
        // A magnet's xs and as hints are fetched the moment the torrent is added — no metadata, no peers
        // needed — so a room's magnet could hand the host's chosen server every viewer's IP and point their
        // browsers at any URL. The helper strips both for that reason; web seeds and trackers stay. magnet-uri
        // parses the raw query itself, so they are dropped by filtering it: rebuilding the string through
        // URLSearchParams would re-encode xt and leave the add without an info hash.
        const params = source.startsWith('magnet:?') ? source.slice(8).split('&') : undefined;
        let added: string | Uint8Array = remote?.infoHash || bridge?.metadata
          || (params ? `magnet:?${params.filter(param => !/^(xs|as)=/i.test(param)).join('&')}` : source);
        // A helper path adds the helper's own id or its rebuilt metadata, and the helper strips what the
        // source says about where else the data lives, so a web-seed-only torrent has nothing left to ask.
        // Carry the source's own web seeds and browser-reachable trackers instead: they are the requests this
        // browser already makes when no helper is paired.
        const carried: { urlList?: string[]; announce?: string[] } = {};
        if (remote || bridge) {
          if (params) {
            const hints = (key: string) => params.filter(param => param.startsWith(`${key}=`)).map(param => decodeURIComponent(param.slice(key.length + 1)));
            carried.urlList = hints('ws').filter(url => /^https:/i.test(url));
            carried.announce = hints('tr').filter(url => /^wss:/i.test(url));
          } else {
            // A .torrent keeps its web seeds and its private flag inside the file, and without a helper this
            // browser fetches that very URL, so read it here rather than guess at either.
            const metadata = await fetch(source, { signal: abort.signal }).then(response => response.ok ? response.arrayBuffer() : null).catch(() => null);
            if (disposed) return;
            if (metadata) added = new Uint8Array(metadata);
          }
        }
        torrent = client.add(added, { strategy: 'sequential', deselect: true, destroyStoreOnDestroy: false, storeCacheSlots: 8, bitfield: verified?.source === source ? verified.bitfield : undefined, ...carried }, value => {
          if (disposed) return;
          // WebTorrent names this browser's store directory after the torrent, and a name holding a slash is
          // one the file system refuses. Nothing notices until the first piece is written, which is long after
          // this movie looked like it was loading, so refuse the name here instead.
          if (/[\\/]/.test(value.name)) { fail('This torrent’s name contains a slash or backslash, which browsers cannot store. Ask the host for another torrent.'); return; }
          // The store survives teardown so a reconnect resumes; nothing else holds one while this tab
          // owns the media lock, so reclaim every other movie here.
          void (async () => {
            const root = await navigator.storage.getDirectory();
            const keep = `${value.name} - ${value.infoHash!.slice(0, 8)}`;
            for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys())
              if (key !== keep) await root.removeEntry(key, { recursive: true }).catch(() => {});
          })().catch(() => {});
          if (bridge) value.addWebSeed(bridge.seedUrl);
          const videos = videoFiles(value.files);
          setFiles(videos.map(file => ({ name: file.name, path: file.path, size: file.length })));
          // Naming the subtitles costs nothing; their bytes are only read once somebody picks one.
          subtitleRef.current = subtitleFiles(value.files);
          setSubtitles(subtitleRef.current.map(file => ({ name: file.name, path: file.path })));
          if (pendingPick.current) setListed(count => count + 1);
          const file = videos[fileIndex];
          if (!videos.length) { fail('No video found. Choose a torrent containing an MKV, MP4, WebM, M4V, or OGV video.'); return; }
          if (!file) { fail(`The host chose video #${fileIndex + 1}, but this torrent has ${videos.length}. Ask the host to pick again.`); return; }
          fileRef.current = file;
          // WebTorrent treats an end of 0 as absent and streams the whole file against a Content-Length of 1.
          file.on('iterator', ({ iterator, req }, replace) => {
            if (!/^bytes=0-0$/.test(req.headers.range || '')) return;
            replace((async function* () { for await (const chunk of iterator) { yield chunk.subarray(0, 1); return; } })());
          });
          setStats(s => ({ ...s, filename: file.name, size: file.length }));
          setStatus('Buffering your seat…');
          if (isMkv(file.name) && (typeof MediaSource === 'undefined' || !MediaSource.canConstructInDedicatedWorker)) {
            fail('This browser cannot play MKV video. Ask the host for an MP4 or WebM version, or watch in Chrome, Edge, or Safari 17.1+ on a computer or iPad.'); return;
          }
          // Selecting the file, and the open-ended ranges the video element asks for, pull the whole video into
          // this browser's store. A private window's allowance is fixed and far smaller than the disk, so a
          // movie that can never fit is refused here rather than partway through the night.
          void navigator.storage.estimate().then(({ quota }) => {
            if (!disposed && quota !== undefined && file.length > quota)
              fail('This movie is larger than the storage this browser allows CouchSwarm. A private window gets much less space than a normal one: open the invite in a normal window, free up disk space, or use another device.');
          }).catch(() => {});
          file.select();
          const playNatively = () => {
            // A codec the browser cannot decode is dropped at demux and the audio plays on: no media error,
            // just a picture that never arrives. Metadata is the first moment a missing track shows.
            video.addEventListener('loadedmetadata', () => {
              if (!disposed && !video.videoWidth) fail('Your browser cannot decode this video’s picture. Ask the host for a version with H.264 video, or watch on a device that supports this codec.');
            }, { once: true, signal: abort.signal });
            file.streamTo(video);
            setLoadedVersion(mediaVersion);
          };
          if (isMkv(file.name)) {
            setStatus('Preparing MKV playback…');
            void import('playsvideo').then(({ PlaysVideoEngine }) => {
              if (disposed) return;
              mkvPlayer = new PlaysVideoEngine(video, { embeddedSubtitlePolicy: 'off' });
              mkvPlayer.addEventListener('ready', () => {
                if (!disposed) { setStatus('Buffering your seat…'); setLoadedVersion(mediaVersion); }
              });
              mkvPlayer.addEventListener('error', event => {
                if (torrentFailed || disposed || mkvNative) return;
                const detail = (event as CustomEvent<{ message?: string }>).detail;
                if (/worker crashed|CompileError|dynamically imported module/i.test(detail?.message || '')) {
                  fail('The MKV player files could not be loaded — this site may have been updated. Reload this page and rejoin.'); return;
                }
                // The demuxer cannot identify DTS, TrueHD or MP2, and muxing a track with no decoder config
                // throws a raw TypeError at everyone in the room. The engine names the case instead; the
                // browser cannot open the container either, so there is nothing to fall back to.
                if (/unsupported-audio/.test(detail?.message || '')) {
                  fail('This movie’s audio (DTS, TrueHD or MP2) cannot be converted in the browser. Ask the host for a version with AAC, AC-3, E-AC-3, MP3, FLAC, or Opus audio.'); return;
                }
                // Loading by URL leaves the engine only its remux path to evaluate, so it refuses codecs this
                // browser plays itself — VP8 video, or LPCM and Vorbis audio it will not convert. Hand the file
                // to the element rather than refuse the movie for the whole room. Set before the teardown, so
                // an error the engine raises on its way out is no longer ours.
                mkvNative = true;
                mkvPlayer?.destroy();
                mkvPlayer = undefined;
                setStatus('Buffering your seat…');
                playNatively();
              });
              // Range requests stay local to WebTorrent's service worker. Video
              // is remuxed and audio converted on demand in this participant's browser.
              mkvPlayer.loadUrl(new URL(file.streamURL, location.href).href);
            }).catch(() => fail('The MKV player could not load. Reload the room and try again.'));
          } else playNatively();
        });
        if (remote) {
          torrent.on('wire', value => {
            // This authenticated bridge downloads requested blocks on demand; a slow swarm is not a dead peer.
            // Match the connection this browser opened: any swarm peer can claim the helper's peer id.
            const peers = (torrent as unknown as { _peers: Map<string, { wire?: unknown }> })._peers;
            if (value === peers?.get(remote.peer.id)?.wire) (value as { setTimeout(ms: number, unref: boolean): void }).setTimeout(0, true);
          });
          const add = () => { if (!disposed) torrent!.addPeer(remote.peer); };
          if (torrent.infoHash) add(); else torrent.once('infoHash', add);
        }
        // A failure before metadata is a torrent that could not be fetched; after it, the link was fine and
        // the bytes could not be stored, so telling the room to check the link sends it after another torrent
        // the helper is already serving.
        torrent.on('error', error => { torrentFailed = true; fail(/quota|storage/i.test(String(error)) || (error as { name?: string }).name === 'QuotaExceededError'
          ? 'Your browser ran out of storage for this movie. A private window gets much less space than a normal one: open the invite in a normal window, free up disk space, or use another device.'
          : gotMetadata ? 'This browser could not save this movie. Reconnect to try again, or ask the host for another torrent.'
          : 'Could not load this torrent. Check the link; .torrent URLs must allow browser access (CORS).'); });
        torrent.on('metadata', () => {
          gotMetadata = true;
          // Verifying this many pieces takes tens of seconds and the picker below would list every file.
          if (torrent!.files.length > MAX_TORRENT_FILES)
            fail(`This torrent has ${torrent!.files.length} files; CouchSwarm handles up to ${MAX_TORRENT_FILES}. Ask the host to choose another torrent.`);
        });
        peerTimer = setTimeout(() => {
          if (disposed) return;
          const file = fileRef.current;
          // No file yet means metadata never arrived, or the retained store is still being hash-verified.
          if (!file) {
            setStatus(gotMetadata ? 'Checking the part of this movie already saved on this device…'
              : bridge || remote ? 'Your helper is connected, but no video pieces have arrived yet. The torrent needs reachable seeders.'
              : helperReason ? `No video data yet. ${helperReason}`
              : 'No video data yet. This torrent needs a WebRTC seeder or an HTTPS web seed to reach your browser.');
            return;
          }
          if (file.downloaded === 0) {
            setStatus(bridge || remote ? 'Your helper is connected, but no video pieces have arrived yet. The torrent needs reachable seeders.'
              : helperReason ? `No video data yet. ${helperReason}`
              : 'No video data yet. This torrent needs a WebRTC seeder or an HTTPS web seed to reach your browser.');
            return;
          }
          // An MKV cannot start until its index, which sits at the end of the file, has arrived.
          if (isMkv(file.name) && !mkvNative && mkvPlayer?.phase !== 'ready') setStatus('Still preparing this MKV. Playback cannot start until the end of the file arrives from the swarm.');
        }, 25_000);
      } catch (err) { fail(err instanceof Error ? err.message : 'Unable to start torrent streaming.'); }
    }
    void start();
    const tick = setInterval(() => {
      if (!torrent || disposed) return;
      // A paused room ticks 0 B/s and 0 peers for as long as it sits there, and a new object every second
      // commits the whole page — player, members, dialogs and all — over numbers that have not moved.
      setStats(s => {
        const speed = torrent!.downloadSpeed, peers = torrent!.numPeers, progress = fileRef.current?.progress ?? 0;
        return s.speed === speed && s.peers === peers && s.progress === progress ? s : { ...s, speed, peers, progress };
      });
      if (video.error) return;
      if (fileRef.current && fileRef.current.downloaded > 0 && (!isMkv(fileRef.current.name) || mkvNative || mkvPlayer?.phase === 'ready')) setStatus('Buffering your seat…');
    }, 1000);
    // The MKV engine owns media errors while it chooses or recovers its playback path; once it has handed the
    // file to the element, the element's errors are read like any other video's.
    const mediaError = () => {
      if (torrentFailed) return;
      if (fileRef.current && isMkv(fileRef.current.name) && !mkvNative) {
        if (mkvPlayer?.phase !== 'ready' || !video.error) return;
        fail(`Your browser stopped decoding this video (error ${video.error.code}). Reconnect to the movie or try a version with H.264 video.`);
        return;
      }
      fail(video.error?.code === MediaError.MEDIA_ERR_NETWORK
        ? 'The video stream was interrupted. Reconnect to the movie to try again.'
        : 'Your browser cannot decode this video. Try a version with H.264 video and AAC audio.');
    };
    video.addEventListener('error', mediaError);
    return () => {
      disposed = true;
      abort.abort();
      clearInterval(tick);
      clearTimeout(peerTimer);
      clearTimeout(helperTimer);
      clearTimeout(healthyTimer);
      clearInterval(cancelProbe);
      video.removeEventListener('error', mediaError);
      mkvPlayer?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      // What this client verified is what the kept store holds, so the replacement need not hash it again.
      if (torrent?.bitfield) verified = { source, bitfield: torrent.bitfield.buffer.slice() };
      // webtorrent 3.0.21 re-arms the video worker's 20 s keepalive on the line after the end-of-stream cleanup
      // that had just cleared it, and neither close nor destroy clears it again, so every client that served a
      // stream to its end — the bytes=0-0 answer above ends one on every load — leaves a fetch timer behind.
      // Stop it here, and once more after destroy, where a late port message could have armed another.
      if (client) {
        const server = (client as unknown as { _server?: { workerKeepAliveInterval?: ReturnType<typeof setInterval> } })._server;
        const stopKeepAlive = () => clearInterval(server?.workerKeepAliveInterval);
        stopKeepAlive();
        teardownRef.current = new Promise<void>(resolve => client!.destroy(() => { stopKeepAlive(); releaseLock?.(); resolve(); }));
      } else releaseLock?.();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- session identity is covered by roomId/token
  }, [source, fileIndex, mediaVersion, videoRef, session?.roomId, session?.token, attempt]);

  // This choice is the participant's own and never reaches room state. The MKV engine only ever touches the
  // <track> elements it created itself, so the one below is attached, shown and removed here alone. Once the
  // cues are a blob the torrent is no longer involved, which is why a helper reconnect leaves it alone.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false, expired = false, url = '';
    let track: HTMLTrackElement | undefined;
    let stream: TorrentFileStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire: ((error: Error) => void) | undefined;
    void (async () => {
      setSubtitleError('');
      // Set on the way in, so abandoning a slow read for another subtitle or for Off cannot latch it true.
      setSubtitleBusy(subtitle !== null);
      pendingPick.current = subtitle !== null;
      if (subtitle === null) return;
      // A sidecar nobody is seeding never arrives, and the swarm cannot say how long it would take. Destroying
      // the stream releases its pieces but leaves the read parked, so the budget rejects the wait itself.
      timer = setTimeout(() => { expired = true; stream?.destroy(); expire?.(new Error('expired')); }, 30_000);
      try {
        const file = typeof subtitle === 'number' ? subtitleRef.current[subtitle] : subtitle;
        // A restarting torrent empties the list this index points into, and the entry is still there once the
        // new client lists its files: keep the pick on 'Loading…' rather than failing it.
        if (!file && !subtitleRef.current.length) return;
        if (!file) throw new Error('That subtitle is no longer part of this torrent.');
        if ((file instanceof File ? file.size : file.length) > MAX_SUBTITLE_BYTES) throw new Error('That file is too large to be a subtitle.');
        const bytes = file instanceof File ? await file.arrayBuffer()
          : await Promise.race([readFromHelper(seedUrlRef.current, file).then(served => served ?? readFile(file, value => { stream = value; })),
            new Promise<never>((_, reject) => { expire = reject; })]);
        if (disposed) return;
        const vtt = toSubtitleCues(bytes, file.name);
        url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = file.name.replace(/\.[^.]+$/, '');
        track.src = url;
        video.appendChild(track);
        // A track added after the element has loaded is not honoured through its default attribute.
        const show = () => { if (track?.track) track.track.mode = 'showing'; };
        track.addEventListener('load', show, { once: true });
        queueMicrotask(show);
        pendingPick.current = false;
        setSubtitleBusy(false);
      } catch (err) {
        if (disposed) return;
        setSubtitleBusy(false);
        setSubtitleError(expired ? 'That subtitle has not arrived from the swarm. Try another, or upload your own.'
          : err instanceof Error ? err.message : 'That subtitle could not be loaded.');
      } finally { clearTimeout(timer); }
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      stream?.destroy();
      track?.remove();
      if (url) URL.revokeObjectURL(url);
    };
  }, [subtitle, picked, videoRef, listed]);

  const reconnect = useCallback(() => { retriedHelper.current = 0; retriedUpgrade.current = false; setAttempt(value => value + 1); }, []);
  // Unpairing only changes what this tab streams from if it was streaming from that helper. Rebuilding the
  // pipeline for a helper that had already stopped empties the video for nothing, and the ready:false the next
  // heartbeat then reports pauses the room for everyone.
  const reconnectIfOwnHelper = useCallback(() => { if (ownHelperLive.current) reconnect(); }, [reconnect]);
  const chooseSubtitle = useCallback((next: number | File | null) => { setSubtitle(next); setPicked(count => count + 1); }, []);

  // The effect's cleanup pulls the attached <track> the moment the pick changes, so committing an upload before
  // reading it means a file that turns out not to be a subtitle leaves the viewer with no subtitles at all and
  // the picker naming the file that failed. Parse it first, and only commit a pick the effect can attach. Says
  // whether it took, so a refused file does not displace the upload already on the list.
  const uploadSubtitle = useCallback(async (file: File) => {
    try {
      if (file.size > MAX_SUBTITLE_BYTES) throw new Error('That file is too large to be a subtitle.');
      toSubtitleCues(await file.arrayBuffer(), file.name);
    } catch (err) {
      setSubtitleError(err instanceof Error ? err.message : 'That subtitle could not be loaded.');
      return false;
    }
    chooseSubtitle(file);
    return true;
  }, [chooseSubtitle]);

  return { status, error, files, stats, loadedVersion, helper, helperPending, reconnect, reconnectIfOwnHelper, subtitles, subtitle, setSubtitle: chooseSubtitle, uploadSubtitle, subtitleError, subtitleBusy };
}
