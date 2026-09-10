'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type WebTorrent from 'webtorrent/dist/webtorrent.min.js';
import type { Torrent, TorrentFile } from 'webtorrent/dist/webtorrent.min.js';
import type { PlaysVideoEngine } from 'playsvideo';
import { isMkv, videoFiles } from '@/lib/video-files';
import { connectHelper } from '@/lib/torrent-helper';
import { connectRemoteHelper, helperStatus } from '@/lib/remote-helper';
import type { Session } from '@/lib/sync';

export function useTorrent(source: string, fileIndex: number, mediaVersion: number, videoRef: RefObject<HTMLVideoElement | null>, session: Session | null) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [files, setFiles] = useState<{ name: string; path: string; size: number }[]>([]);
  const [stats, setStats] = useState({ speed: 0, peers: 0, progress: 0, filename: '', size: 0 });
  const [loadedVersion, setLoadedVersion] = useState(-1);
  const [helper, setHelper] = useState<{ peers?: number; host?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fileRef = useRef<TorrentFile | null>(null);
  const retriedHelper = useRef(false);
  const retriedUpgrade = useRef(false);
  const movieRef = useRef('');
  const teardownRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let client: WebTorrent | undefined;
    let torrent: Torrent | undefined;
    let mkvPlayer: PlaysVideoEngine | undefined;
    let peerTimer: ReturnType<typeof setTimeout> | undefined;
    let helperTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseLock: (() => void) | undefined;
    const abort = new AbortController();
    // Helper retry budgets are per movie, not per hook mount.
    const movie = `${source}|${mediaVersion}|${fileIndex}`;
    if (movieRef.current !== movie) { movieRef.current = movie; retriedHelper.current = false; retriedUpgrade.current = false; }
    fileRef.current = null;
    setLoadedVersion(-1);
    setHelper(null);
    setFiles([]);
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
        if (!locked) { fail('This movie is already open in another CouchSwarm tab.'); return; }
        if (disposed) { releaseLock?.(); return; }
        const { default: TorrentClient } = await import('webtorrent/dist/webtorrent.min.js');
        if (disposed) return;
        const registration = await navigator.serviceWorker.register('/sw.min.js', { scope: '/' });
        await navigator.serviceWorker.ready;
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
            // Selection has already re-pointed at the host's helper, so retry once before giving up.
            if (!retriedHelper.current) { retriedHelper.current = true; setAttempt(value => value + 1); return; }
            fail(`${own ? 'Your' : 'The host’s'} helper disconnected. Reconnect to the movie to try again.`);
          }).catch(err => { if (abort.signal.aborted) throw err; helperFailed = retriedUpgrade.current; retriedUpgrade.current = true; setStatus('Helper unavailable, using browser peers…'); return null; }) : null;
        if (remote) setHelper({ host: !remote.own });
        const bridge = session && !remote ? await connectHelper(session, source, mediaVersion, abort.signal, value => {
          if (disposed) return;
          setHelper({ peers: value.peers });
          if (!value.ready) setStatus(`Your helper is finding torrent peers… ${value.peers} connected`);
        }) : null;
        if (disposed) return;
        if (bridge) {
          const heartbeat = async () => {
            try { await bridge.status(); }
            catch { bridge.release(); if (!disposed) fail('The torrent helper disconnected. Reconnect to the movie to try again.'); return; }
            if (!disposed) helperTimer = setTimeout(() => void heartbeat(), 5000);
          };
          helperTimer = setTimeout(() => void heartbeat(), 5000);
        }
        if (session && !remote && !bridge && !helperFailed) {
          // A helper that becomes ready later upgrades this browser-only stream. The restart
          // deletes this attempt's store, so adopt one only before any video bytes land.
          // A helper that was offered and could not be reached is upgraded to once per movie, never in a loop.
          const watch = async () => {
            try {
              const { ready } = await helperStatus(session, abort.signal);
              if (disposed) return;
              if (ready) { if (!fileRef.current?.downloaded) setAttempt(value => value + 1); return; }
            }
            catch { /* The room connection already reports connectivity failures. */ }
            if (!disposed) helperTimer = setTimeout(() => void watch(), document.hidden ? 30000 : 15000);
          };
          helperTimer = setTimeout(() => void watch(), document.hidden ? 30000 : 15000);
        }
        torrent = client.add(remote?.infoHash || bridge?.metadata || source, { strategy: 'sequential', deselect: true, destroyStoreOnDestroy: true }, value => {
          if (disposed) return;
          // Nothing else holds a store while this tab owns the media lock; reclaim movies left by closed tabs.
          void (async () => {
            const root = await navigator.storage.getDirectory();
            const keep = `${value.name} - ${value.infoHash!.slice(0, 8)}`;
            for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys())
              if (key !== keep) await root.removeEntry(key, { recursive: true }).catch(() => {});
          })().catch(() => {});
          if (bridge) value.addWebSeed(bridge.seedUrl);
          const videos = videoFiles(value.files);
          setFiles(videos.map(file => ({ name: file.name, path: file.path, size: file.length })));
          const file = videos[fileIndex];
          if (!videos.length) { fail('No video found. Choose a torrent containing an MKV, MP4, WebM, M4V, or OGV video.'); return; }
          if (!file) { fail(`The host chose video #${fileIndex + 1}, but this torrent has ${videos.length}. Ask the host to pick again.`); return; }
          fileRef.current = file;
          setStats(s => ({ ...s, filename: file.name, size: file.length }));
          setStatus('Buffering your seat…');
          file.select();
          if (isMkv(file.name)) {
            if (typeof MediaSource === 'undefined' || !MediaSource.canConstructInDedicatedWorker) {
              fail('This browser cannot play MKV video. Ask the host for an MP4 or WebM version, or watch in Chrome or Edge.'); return;
            }
            setStatus('Preparing MKV playback…');
            void import('playsvideo').then(({ PlaysVideoEngine }) => {
              if (disposed) return;
              mkvPlayer = new PlaysVideoEngine(video, { embeddedSubtitlePolicy: 'off' });
              mkvPlayer.addEventListener('ready', () => {
                if (!disposed) { setStatus('Buffering your seat…'); setLoadedVersion(mediaVersion); }
              });
              mkvPlayer.addEventListener('error', event => {
                const detail = (event as CustomEvent<{ message?: string }>).detail;
                fail(/worker crashed|CompileError|dynamically imported module/i.test(detail?.message || '')
                  ? 'The MKV player files could not be loaded — this site may have been updated. Reload this page and rejoin.'
                  : `MKV playback could not start. ${detail?.message || 'This device may not support the video codec.'}`);
              });
              // Range requests stay local to WebTorrent's service worker. Video
              // is remuxed and audio converted on demand in this participant's browser.
              mkvPlayer.loadUrl(new URL(file.streamURL, location.href).href);
            }).catch(() => fail('The MKV player could not load. Reload the room and try again.'));
          } else {
            file.streamTo(video);
            setLoadedVersion(mediaVersion);
          }
        });
        if (remote) {
          torrent.on('wire', value => {
            const wire = value as { peerId: string; setTimeout(ms: number, unref: boolean): void };
            // This authenticated bridge downloads requested blocks on demand; a slow swarm is not a dead peer.
            if (wire.peerId?.startsWith('2d4353303030312d')) wire.setTimeout(0, true);
          });
          const add = () => { if (!disposed) torrent!.addPeer(remote.peer); };
          if (torrent.infoHash) add(); else torrent.once('infoHash', add);
        }
        torrent.on('error', error => fail(/quota|storage/i.test(String(error))
          ? 'Your browser ran out of storage for this movie. Free up disk space or use another device.'
          : 'Could not load this torrent. Check the link; .torrent URLs must allow browser access (CORS).'));
        peerTimer = setTimeout(() => {
          if (!disposed && (!fileRef.current || fileRef.current.downloaded === 0)) {
            setStatus(bridge || remote ? 'Your helper is connected, but no video pieces have arrived yet. The torrent needs reachable seeders.'
              : 'No video data yet. Start CouchSwarm with the torrent helper to reach ordinary torrent peers, or use a torrent with a WebRTC seeder or HTTPS web seed.');
          }
        }, 25_000);
      } catch (err) { fail(err instanceof Error ? err.message : 'Unable to start torrent streaming.'); }
    }
    void start();
    const tick = setInterval(() => {
      if (!torrent || disposed) return;
      setStats(s => ({ ...s, speed: torrent!.downloadSpeed, peers: torrent!.numPeers, progress: fileRef.current?.progress ?? 0 }));
      if (video.error) return;
      if (fileRef.current && fileRef.current.downloaded > 0 && (!isMkv(fileRef.current.name) || mkvPlayer?.phase === 'ready')) setStatus('Buffering your seat…');
    }, 1000);
    // The MKV engine owns media errors while it chooses or recovers its playback path.
    const mediaError = () => {
      if (fileRef.current && isMkv(fileRef.current.name)) {
        if (mkvPlayer?.phase !== 'ready' || !video.error) return;
        fail(`Your browser stopped decoding this video (error ${video.error.code}). Reconnect to the movie or try a version with H.264 video.`);
        return;
      }
      fail('Your browser cannot decode this video. Try a version with H.264 video and AAC audio.');
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
      if (client) teardownRef.current = new Promise<void>(resolve => client!.destroy(() => { releaseLock?.(); resolve(); }));
      else releaseLock?.();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- session identity is covered by roomId/token
  }, [source, fileIndex, mediaVersion, videoRef, session?.roomId, session?.token, attempt]);

  const reconnect = useCallback(() => { retriedHelper.current = false; retriedUpgrade.current = false; setAttempt(value => value + 1); }, []);
  return { status, error, files, stats, loadedVersion, helper, reconnect };
}
