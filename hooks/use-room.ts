'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { allReady, bufferedAhead, estimateServerNow, hasBuffer, timelinePosition, validSource, type Session, type Snapshot } from '@/lib/sync';
import { useTorrent } from '@/hooks/use-torrent';

export function useRoom(videoRef: RefObject<HTMLVideoElement | null>) {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invitation, setInvitation] = useState<{ roomId: string; invite: string } | null>(null);
  const [error, setError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [armed, setArmed] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [duration, setDuration] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const room = snapshot?.room;
  const media = useTorrent(room?.source || '', room?.fileIndex || 0, room?.mediaVersion ?? -1, videoRef, session);
  const live = useRef({ snapshot, session, armed, media });
  useEffect(() => { live.current = { snapshot, session, armed, media }; });
  const anchor = useRef({ server: 0, local: 0 });
  const lastContact = useRef(0);
  const latestResponse = useRef(0);
  const sequence = useRef(0);
  const appliedEpoch = useRef(-1);
  const mediaPlaying = useRef(false);
  const unlocking = useRef(false);
  const rtt = useRef(0);
  const best = useRef({ rtt: Infinity, at: 0 });
  const staleControl = useRef(false);
  const creating = useRef<Promise<boolean> | null>(null);
  const leaving = useRef(false);
  const localNow = () => anchor.current.server + (performance.now() - anchor.current.local);

  useEffect(() => {
    setDuration(0);
    setBuffered(0);
    setPlayhead(0);
    setCountdown(0);
    appliedEpoch.current = -1;
  }, [room?.mediaVersion]);

  const accept = useCallback((data: Snapshot, sent: number) => {
    if (!data?.room) return false;
    const current = live.current.snapshot;
    if (data.serverNow < latestResponse.current || (current && data.room.revision < current.room.revision)) return true;
    latestResponse.current = data.serverNow;
    const received = performance.now();
    const roundTrip = received - sent;
    if (!anchor.current.server || (roundTrip < 1500 && (roundTrip <= best.current.rtt * 1.25 || received - best.current.at > 60_000))) {
      anchor.current = { server: estimateServerNow(data.serverNow, data.serverReceivedAt, roundTrip), local: received };
      best.current = { rtt: roundTrip, at: received };
    }
    rtt.current = Math.max(roundTrip, rtt.current * 0.8);
    lastContact.current = received;
    if (staleControl.current && current && data.room.revision > current.room.revision) { staleControl.current = false; setError(''); }
    live.current.snapshot = data;
    setSnapshot(data);
    setConnected(true);
    return true;
  }, []);

  const request = useCallback(async <T,>(path: string, body: Record<string, unknown>, token?: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('The room could not be reached. Try again.'); }
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw Object.assign(new Error(data.error || 'The room could not be reached. Try again.'), { status: response.status });
    return data as T;
  }, []);

  const saveSession = useCallback((value: Session) => {
    // Only the device's access credential lives here. Room state is authoritative on the server.
    try {
      sessionStorage.setItem(`couchswarm:${value.roomId}`, JSON.stringify(value));
      if (value.hostKey) localStorage.setItem(`couchswarm:host:${value.roomId}`, value.hostKey);
    } catch { /* Storage blocked: the seat lives in memory until this tab closes. */ }
    history.replaceState(null, '', `?room=${value.roomId}#invite=${value.invite}`);
    setSession(value);
    setInvitation(null);
    setError('');
  }, []);

  useEffect(() => {
    if (typeof AbortSignal.any !== 'function') { setError('CouchSwarm needs a current browser: Chrome or Edge 116+, Firefox 124+, or Safari 17.4+.'); return; }
    const roomId = new URLSearchParams(location.search).get('room');
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
    if (!roomId) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(`couchswarm:${roomId}`) || 'null') as Session | null;
      if (saved?.roomId === roomId && saved.token) { setSession(saved); return; }
    } catch { /* An expired tab credential can be replaced by the invite. */ }
    setInvitation({ roomId, invite });
  }, []);

  const create = (source = '', name = '') => {
    if (creating.current) { setError('Still creating the room. Try again in a moment.'); return Promise.resolve(false); }
    creating.current = (async () => {
      if (source && !validSource(source.trim())) { setError('Enter a valid magnet link or HTTPS .torrent URL.'); return false; }
      setBusy(true); setError('');
      try { saveSession(await request<Session>('/api/rooms', { source: source.trim(), name })); return true; }
      catch (err) { setError((err as Error).message); return false; }
      finally { setBusy(false); }
    })().finally(() => { creating.current = null; });
    return creating.current;
  };

  const join = async (name: string) => {
    if (!invitation) return;
    setBusy(true); setError('');
    let hostKey: string | undefined;
    try { hostKey = localStorage.getItem(`couchswarm:host:${invitation.roomId}`) || undefined; } catch { /* Blocked storage only costs the host their re-claim. */ }
    try { saveSession(await request<Session>(`/api/rooms/${invitation.roomId}`, { action: 'join', name, invite: invitation.invite, hostKey })); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!session) return;
    if (!sequence.current) sequence.current = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const heartbeat = async () => {
      if (leaving.current) return;
      const state = live.current;
      const current = state.snapshot?.room;
      const video = videoRef.current;
      const now = current ? localNow() : 0;
      const target = current ? timelinePosition(current, now) : 0;
      const ahead = video ? bufferedAhead(video.buffered, target) : 0;
      const ready = !!(current && video && state.armed && !state.media.error && state.media.loadedVersion === current.mediaVersion
        && appliedEpoch.current === current.epoch && video.readyState >= 2 && !video.seeking
        && Math.abs(video.currentTime - target) < 1.5 && hasBuffer(ahead, target, video.duration, current.playing));
      const sent = performance.now();
      try {
        const data = await request<Snapshot>(`/api/rooms/${session.roomId}`, { action: current ? 'heartbeat' : 'snapshot',
          ready, buffered: ahead, progress: state.media.stats.progress, epoch: current?.epoch ?? -1,
          mediaVersion: state.media.loadedVersion, duration: video && Number.isFinite(video.duration) ? video.duration : 0,
          sequence: ++sequence.current,
        }, session.token);
        if (!stopped) setNetworkError(accept(data, sent) ? '' : 'The room sent an unexpected reply. Retrying.');
      } catch (err) {
        if (stopped) return;
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 404 || status === 410) {
          try { sessionStorage.removeItem(`couchswarm:${session.roomId}`); } catch { /* Storage blocked: nothing to clear. */ }
          const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
          setSession(null); setSnapshot(null); setConnected(false);
          if (status === 401 && invite) setInvitation({ roomId: session.roomId, invite }); else setError((err as Error).message);
          return;
        }
        setNetworkError((err as Error).message);
      }
      if (!stopped && !leaving.current) timer = setTimeout(heartbeat, Math.max(0, 1000 - (performance.now() - sent)));
    };
    void heartbeat();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, request, accept, videoRef]);

  useEffect(() => {
    const tick = setInterval(() => {
      const state = live.current;
      const current = state.snapshot?.room;
      const video = videoRef.current;
      if (!current || !video) return;
      if (unlocking.current) return;
      if (performance.now() - lastContact.current > Math.max(3500, 1000 + 2 * rtt.current)) { video.pause(); setConnected(false); return; }
      if (state.media.loadedVersion !== current.mediaVersion || video.readyState < 1) return;
      const now = localNow();
      const target = timelinePosition(current, now);
      const drift = target - video.currentTime;
      if (appliedEpoch.current !== current.epoch || Math.abs(drift) > 0.75 || (!current.playing && Math.abs(drift) > .12)) {
        if (!video.seeking) { video.currentTime = target; appliedEpoch.current = current.epoch; }
      }
      const shouldPlay = current.playing && now >= current.startsAt && state.armed && !state.media.error && !video.ended;
      if (shouldPlay) {
        video.playbackRate = Math.abs(drift) > .15 ? (drift > 0 ? 1.03 : .97) : Math.abs(drift) < .05 ? 1 : video.playbackRate;
        if (video.paused && !mediaPlaying.current) {
          mediaPlaying.current = true;
          void video.play().catch(err => { if ((err as Error).name === 'NotAllowedError') setArmed(false); }).finally(() => { mediaPlaying.current = false; });
        }
      } else { video.pause(); video.playbackRate = 1; }
      const ahead = bufferedAhead(video.buffered, target);
      setPlayhead(value => Math.floor(value) === Math.floor(target) ? value : target);
      setBuffered(value => Math.floor(value) === Math.floor(ahead) ? value : ahead);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCountdown(current.playing ? Math.max(0, Math.ceil((current.startsAt - now) / 1000)) : 0);
    }, 100);
    return () => clearInterval(tick);
  }, [videoRef]);

  const control = async (action: string, extra: Record<string, unknown> = {}) => {
    const state = live.current;
    if (!state.session) return false;
    if (!state.snapshot) { setError('Still connecting to the room. Try again in a moment.'); return false; }
    setBusy(true); setError('');
    const sent = performance.now();
    try {
      const data = await request<Snapshot>(`/api/rooms/${state.session.roomId}`, { action, revision: state.snapshot.room.revision, ...extra }, state.session.token);
      if (!accept(data, sent)) { setError('The room sent an unexpected reply. Try that again.'); return false; }
      const rotated = (data as unknown as { invite?: string }).invite;
      if (rotated) saveSession({ ...state.session, invite: rotated });
      return true;
    } catch (err) { staleControl.current = (err as { status?: number }).status === 409; setError((err as Error).message); return false; }
    finally { setBusy(false); }
  };

  const enable = async () => {
    const video = videoRef.current;
    if (!video || unlocking.current) return;
    unlocking.current = true;
    const started = video.play();
    try {
      await Promise.race([started, new Promise(resolve => setTimeout(resolve, 1500))]);
      video.pause();
      setArmed(true);
      setError('');
    } catch { setError('Playback could not start yet. Allow more time to buffer, then try again.'); }
    finally { void started.catch(() => {}); unlocking.current = false; }
  };

  const sendLeave = useCallback((value: Session) => {
    void fetch(`/api/rooms/${value.roomId}`, { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value.token}` },
      body: JSON.stringify({ action: 'leave' }) }).catch(() => { /* Presence expires if the connection was lost. */ });
  }, []);

  const leave = () => {
    if (session) {
      leaving.current = true;
      sendLeave(session);
      try { sessionStorage.removeItem(`couchswarm:${session.roomId}`); localStorage.removeItem(`couchswarm:host:${session.roomId}`); } catch { /* Storage blocked: nothing to clear. */ }
    }
    location.assign('/');
  };

  const isHost = room ? room.hostId === session?.memberId : !session;
  const everyoneReady = !!(room && snapshot && allReady(snapshot.members, room, snapshot.serverNow));
  return { session, room, members: snapshot?.members || [], invitation, error: error || networkError, busy, connected, armed, playhead,
    buffered, duration, countdown, media, isHost, everyoneReady, create, join, control, enable, leave,
    inviteUrl: session ? `${typeof location === 'undefined' ? '' : location.origin}/?room=${session.roomId}#invite=${session.invite}` : '',
  };
}
