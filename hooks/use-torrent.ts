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
  const [attempt, setAttempt] = useState(0);
  const fileRef = useRef<TorrentFile | null>(null);
  const retriedHelper = useRef(0);
  const retriedUpgrade = useRef(false);
  // A restart that lost its helper may adopt the returning one even though the kept store already holds bytes.
  const lostHelper = useRef(false);
  const movieRef = useRef('');
  const sourceRef = useRef('');
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
    let releaseLock: (() => void) | undefined;
    const abort = new AbortController();
    // Helper retry budgets are per movie, not per hook mount.
    const movie = `${source}|${mediaVersion}|${fileIndex}`;
    // A subtitle chosen for the last movie would index a file list this one does not have.
    if (movieRef.current !== movie) { movieRef.current = movie; retriedHelper.current = 0; retriedUpgrade.current = false; lostHelper.current = false; setSubtitle(null); }
    fileRef.current = null;
    subtitleRef.current = [];
    setLoadedVersion(-1);
    setHelper(null);
    // The file list belongs to the torrent, not the selection: keep it across a file switch so the picker stays mounted.
    if (sourceRef.current !== source) { sourceRef.current = source; setFiles([]); setSubtitles([]); }
    setError('');
    setStats({ speed: 0, peers: 0, progress: 0, filename: '', size: 0 });
    setStatus(source ? 'Finding your movie…' : '');
    const fail = (message: string) => { if (!disposed) { setError(message); setStatus(''); } };

    async function start() {
      if (!source || !video) return;
      // Torrent stores are keyed by info hash. A replacement must wait for the
      // old store to be destroyed before opening the same torrent again.
      await teardownRef.current;
      if (disposed) return;
      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('RTCPeerConnection' in window)) {
        fail('Use a current browser over HTTPS or localhost to stream torrents.'); return;
      }
      try {
        // One torrent store per browser profile: a second tab opens the same OPFS
        // directory and its teardown deletes the pieces this tab downloaded.
        const locked = await new Promise<boolean>(resolve => {
          void navigator.locks.request('couchswarm:media', { ifAvailable: true }, lock => {
            resolve(!!lock);
            return lock ? new Promise<void>(release => { releaseLock = release; }) : undefined;
          }).catch(() => resolve(false));
        });
        if (!locked) { try { sessionStorage.removeItem('couchswarm:sw-reload'); } catch { /* Storage blocked: nothing to clear. */ } fail('This movie is already open in another CouchSwarm tab. Close or reload that tab, then reconnect here.'); return; }
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
            if (registration.active && !sessionStorage.getItem('couchswarm:sw-reload')) {
              sessionStorage.setItem('couchswarm:sw-reload', '1');
              location.reload();
              return;
            }
            if (!(await claimed(15000))) throw new Error('Streaming could not start. Reload this page.');
          }
        }
        sessionStorage.removeItem('couchswarm:sw-reload');
        if (disposed) return;
        // Magnets often list only UDP trackers, which browsers cannot contact.
        // Shared WebSocket trackers let this client discover WebRTC seeders.
        client = new TorrentClient({ tracker: { announce: [
          'wss://tracker.openwebtorrent.com',
          'wss://tracker.webtorrent.dev',
        ] } });
        client.on('error', () => fail('The torrent connection failed. Try a different torrent or reload the room.'));
        client.createServer({ controller: registration });
        let helperFailed = false;
        const remote = session ? await connectRemoteHelper(session, mediaVersion, abort.signal, setStatus,
          own => {
            if (fileRef.current?.progress === 1) return;
            setHelper(null);
            lostHelper.current = true;
            // Selection has already re-pointed at the host's helper, and a helper reloads a torrent that failed
            // after serving, so allow a few reconnects before giving up.
            if (retriedHelper.current < 3) { retriedHelper.current++; setAttempt(value => value + 1); return; }
            fail(`${own ? 'Your' : 'The host’s'} helper disconnected. Reconnect to the movie to try again.`);
          // A stale chunk is not a helper that could not be reached: it tells the viewer to reload instead of
          // spending this movie's one upgrade attempt on a browser-only stream.
          }).catch(err => { if (abort.signal.aborted || (err as { stale?: boolean }).stale) throw err; helperFailed = retriedUpgrade.current; retriedUpgrade.current = true; setStatus('Helper unavailable, using browser peers…'); return null; }) : null;
        if (remote) setHelper({ host: !remote.own });
        const bridge = session && !remote ? await connectHelper(session, source, mediaVersion, abort.signal, value => {
          if (disposed) return;
          setHelper({ peers: value.peers });
          if (!value.ready) setStatus(`Your helper is finding torrent peers… ${value.peers} connected`);
        }).catch(err => { if (abort.signal.aborted) throw err; setStatus('Helper unavailable, using browser peers…'); return null; }) : null;
        if (disposed) return;
        if (bridge) {
          const heartbeat = async () => {
            try { await bridge.status(); }
            catch (err) {
              bridge.release();
              const reported = err instanceof Error && (err as { status?: number }).status !== undefined ? err.message : '';
              if (!disposed) fail(reported || 'The torrent helper disconnected. Reconnect to the movie to try again.');
              return;
            }
            if (!disposed) helperTimer = setTimeout(() => void heartbeat(), 5000);
          };
          helperTimer = setTimeout(() => void heartbeat(), 5000);
        }
        if (remote || bridge) lostHelper.current = false;
        if (session && !bridge && !helperFailed && !remote?.own) {
          // A helper that becomes ready later upgrades this browser-only stream, and a guest on the host's
          // helper remounts onto their own once it is ready. The restart interrupts playback, so adopt one
          // only before any video bytes land — unless this stream lost its helper, where the kept store's
          // bytes say nothing about the swarm and the stall is worse than the interruption.
          // A helper that was offered and could not be reached is upgraded to once per movie, never in a loop.
          const watch = async () => {
            try {
              const { ready, own } = await helperStatus(session, abort.signal);
              if (disposed) return;
              if (ready && (!remote || own)) { if (!fileRef.current?.downloaded || lostHelper.current) setAttempt(value => value + 1); return; }
            }
            catch { /* The room connection already reports connectivity failures. */ }
            if (!disposed) helperTimer = setTimeout(() => void watch(), document.hidden ? 30000 : 15000);
          };
          helperTimer = setTimeout(() => void watch(), document.hidden ? 30000 : 15000);
        }
        torrent = client.add(remote?.infoHash || bridge?.metadata || source, { strategy: 'sequential', deselect: true, destroyStoreOnDestroy: false, storeCacheSlots: 8, bitfield: verified?.source === source ? verified.bitfield : undefined }, value => {
          if (disposed) return;
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
          if (pendingPick.current) setListed(value => value + 1);
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
            fail('This browser cannot play MKV video. Ask the host for an MP4 or WebM version, or watch in Chrome or Edge.'); return;
          }
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
        torrent.on('error', error => { torrentFailed = true; fail(/quota|storage/i.test(String(error))
          ? 'Your browser ran out of storage for this movie. Free up disk space or use another device.'
          : 'Could not load this torrent. Check the link; .torrent URLs must allow browser access (CORS).'); });
        torrent.on('metadata', () => { gotMetadata = true; });
        peerTimer = setTimeout(() => {
          if (disposed) return;
          const file = fileRef.current;
          // No file yet means metadata never arrived, or the retained store is still being hash-verified.
          if (!file) {
            setStatus(gotMetadata ? 'Checking the part of this movie already saved on this device…'
              : bridge || remote ? 'Your helper is connected, but no video pieces have arrived yet. The torrent needs reachable seeders.'
              : 'No video data yet. Start CouchSwarm with the torrent helper to reach ordinary torrent peers, or use a torrent with a WebRTC seeder or HTTPS web seed.');
            return;
          }
          if (file.downloaded === 0) {
            setStatus(bridge || remote ? 'Your helper is connected, but no video pieces have arrived yet. The torrent needs reachable seeders.'
              : 'No video data yet. Start CouchSwarm with the torrent helper to reach ordinary torrent peers, or use a torrent with a WebRTC seeder or HTTPS web seed.');
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
      setStats(s => ({ ...s, speed: torrent!.downloadSpeed, peers: torrent!.numPeers, progress: fileRef.current?.progress ?? 0 }));
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
      video.removeEventListener('error', mediaError);
      mkvPlayer?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      // What this client verified is what the kept store holds, so the replacement need not hash it again.
      if (torrent?.bitfield) verified = { source, bitfield: torrent.bitfield.buffer.slice() };
      if (client) teardownRef.current = new Promise<void>(resolve => client!.destroy(() => { releaseLock?.(); resolve(); }));
      else releaseLock?.();
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
        const bytes = file instanceof File ? await file.arrayBuffer()
          : await Promise.race([readFile(file, value => { stream = value; }), new Promise<never>((_, reject) => { expire = reject; })]);
        if (disposed) return;
        const vtt = toWebVTT(decodeSubtitle(bytes), file.name);
        // A file the picker could not parse would otherwise attach an empty track and show nothing at all.
        if (!vtt.includes(' --> ')) throw new Error('No subtitles could be read out of that file.');
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
  }, [subtitle, videoRef, listed]);

  const reconnect = useCallback(() => { retriedHelper.current = 0; retriedUpgrade.current = false; setAttempt(value => value + 1); }, []);
  return { status, error, files, stats, loadedVersion, helper, reconnect, subtitles, subtitle, setSubtitle, subtitleError, subtitleBusy };
}
