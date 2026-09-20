'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { allReady, bufferedAhead, estimateServerNow, hasBuffer, PRESENCE_MS, timelinePosition, validSource, type Session, type Snapshot } from '@/lib/sync';
import { useTorrent } from '@/hooks/use-torrent';

const seats = new Map<string, Promise<boolean>>();
// One seat per browser profile: a duplicated tab shares this session's token and would fight it for the seat.
// Memoised per document and room, so a remount or a rotated session never re-requests a lock this tab already holds.
function claimSeat(roomId: string) {
  let seat = seats.get(roomId);
  if (!seat) {
    seat = new Promise<boolean>(resolve => {
      if (typeof navigator.locks === 'undefined') { resolve(true); return; }
      void navigator.locks.request(`couchswarm:seat:${roomId}`, { ifAvailable: true }, lock => {
        resolve(!!lock);
        return lock ? new Promise<void>(() => { /* Held until this document goes away. */ }) : undefined;
      }).catch(() => resolve(true));
    });
    seats.set(roomId, seat);
  }
  return seat;
}

export function useRoom(videoRef: RefObject<HTMLVideoElement | null>) {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invitation, setInvitation] = useState<{ roomId: string; invite: string } | null>(null);
  const [error, setError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [refused, setRefused] = useState(false);
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
  const pending = useRef(false);
  const bridged = useRef({ epoch: -1, until: 0, touches: 0 });
  const rtt = useRef(0);
  const best = useRef({ rtt: Infinity, at: 0 });
  const staleControl = useRef(false);
  // A transient control failure still self-heals, but a 1 Hz heartbeat must not wipe it before it is read.
  const controlError = useRef(0);
  const creating = useRef<Promise<boolean> | null>(null);
  const leaving = useRef(false);
  const clocks = useRef({ wall: 0, perf: 0 });
  // Stable so the callbacks that read the shared clock do not have to be rebuilt every render.
  const localNow = useCallback(() => anchor.current.server + (performance.now() - anchor.current.local), []);
  // performance.now() can stand still across a suspend on Linux and macOS while Date.now() keeps wall time, so a
  // gap between the two means the tab slept and the anchor is minutes behind. Drop it: the next reply re-anchors.
  const checkSleep = useCallback(() => {
    const wall = Date.now();
    const perf = performance.now();
    if (clocks.current.wall && (wall - clocks.current.wall) - (perf - clocks.current.perf) > 1000) anchor.current = { server: 0, local: 0 };
    clocks.current = { wall, perf };
  }, []);

  useEffect(() => {
    setDuration(0);
    setBuffered(0);
    setPlayhead(0);
    setCountdown(0);
    appliedEpoch.current = -1;
    bridged.current = { epoch: -1, until: 0, touches: 0 };
  }, [room?.mediaVersion]);
  // A rebuilt pipeline (Reconnect, a helper upgrade) starts on an empty buffer, so give the edge touch a fresh budget.
  useEffect(() => { bridged.current = { epoch: -1, until: 0, touches: 0 }; }, [media.loadedVersion]);

  const applyRoomState = useCallback(() => {
    const state = live.current;
    const current = state.snapshot?.room;
    const video = videoRef.current;
    if (!current || !video) return;
    if (unlocking.current) return;
    checkSleep();
    // A tab that just woke has no usable clock, so nothing may play against its timeline until a reply re-anchors it.
    if (!anchor.current.server) { video.pause(); setConnected(false); return; }
    // A request still in flight is proof the tab is alive, but only until its 10 s abort would have fired.
    if ((!pending.current || performance.now() - lastContact.current > 11000) && performance.now() - lastContact.current > Math.max(3500, 1000 + 2 * rtt.current)) { video.pause(); setConnected(false); return; }
    if (state.media.loadedVersion !== current.mediaVersion || video.readyState < 1) return;
    const now = localNow();
    const target = timelinePosition(current, now);
    const drift = target - video.currentTime;
    if (performance.now() >= bridged.current.until && (appliedEpoch.current !== current.epoch || Math.abs(drift) > 0.75 || (!current.playing && Math.abs(drift) > .12))) {
      if (!video.seeking) { video.currentTime = target; appliedEpoch.current = current.epoch; }
    }
    const shouldPlay = current.playing && now >= current.startsAt && state.armed && !state.media.error && !video.ended;
    if (shouldPlay) {
      // Half the error, capped at a still-inaudible 8 %, quantised so a 10 Hz tick does not churn the resampler.
      const rate = Math.abs(drift) < .05 ? 1 : 1 + Math.max(-.08, Math.min(.08, Math.round(drift * 50) / 100));
      if (video.playbackRate !== rate) video.playbackRate = rate;
      if (video.paused && !mediaPlaying.current) {
        mediaPlaying.current = true;
        void video.play().catch(err => { if ((err as Error).name === 'NotAllowedError') setArmed(false); }).finally(() => { mediaPlaying.current = false; });
      }
    } else { video.pause(); video.playbackRate = 1; }
    const ahead = bufferedAhead(video.buffered, target);
    // A paused element never fetches past the edge it stopped at, so a hole or a suspended read leaves the
    // ready gate unreachable. One touch only parses about 2.25 s more, which a faststart header's gap
    // outlasts, so keep touching while the gate is unreachable; the drift corrector brings the playhead back.
    if (bridged.current.epoch !== current.epoch) bridged.current = { epoch: current.epoch, until: 0, touches: 0 };
    if (!current.playing && appliedEpoch.current === current.epoch && bridged.current.touches < 8
      && performance.now() >= bridged.current.until + 900
      && video.readyState >= 3 && !video.seeking && !video.ended && ahead > 0
      && Math.abs(video.currentTime - target) < .12 && !hasBuffer(ahead, target, video.duration, false)) {
      bridged.current = { epoch: current.epoch, until: performance.now() + 600, touches: bridged.current.touches + 1 };
      video.currentTime = target + ahead + 0.05;
    }
    setPlayhead(value => Math.floor(value) === Math.floor(target) ? value : target);
    setBuffered(value => Math.floor(value) === Math.floor(ahead) ? value : ahead);
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setCountdown(current.playing ? Math.max(0, Math.ceil((current.startsAt - now) / 1000)) : 0);
  }, [videoRef, localNow, checkSleep]);

  const accept = useCallback((data: Snapshot, sent: number) => {
    if (!data?.room) return false;
    const current = live.current.snapshot;
    if (data.serverNow < latestResponse.current || (current && data.room.revision < current.room.revision)) return true;
    latestResponse.current = data.serverNow;
    const received = performance.now();
    const roundTrip = received - sent;
    const network = Math.max(0, roundTrip - (data.serverNow - data.serverReceivedAt));
    if (!anchor.current.server || (network < 1500 && (network <= best.current.rtt * 1.25 || received - best.current.at > 60_000))) {
      anchor.current = { server: estimateServerNow(data.serverNow, data.serverReceivedAt, roundTrip), local: received };
      best.current = { rtt: network, at: received };
    }
    rtt.current = Math.max(roundTrip, rtt.current * 0.8);
    lastContact.current = received;
    if (staleControl.current && current && data.room.revision > current.room.revision) { staleControl.current = false; setError(''); }
    live.current.snapshot = data;
    setSnapshot(data);
    setConnected(true);
    applyRoomState();
    return true;
  }, [applyRoomState]);

  const request = useCallback(async <T,>(path: string, body: Record<string, unknown>, token?: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('The room could not be reached. Try again.'); }
    const data = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw Object.assign(new Error(data?.error || 'The room could not be reached. Try again.'), { status: response.status });
    if (!data) throw new Error('The room could not be reached. Try again.');
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
    if (typeof AbortSignal.any !== 'function') { setUnsupported(true); setError('CouchSwarm needs a current browser: Chrome or Edge 116+, Firefox 124+, or Safari 17.4+.'); return; }
    const roomId = new URLSearchParams(location.search).get('room');
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
    if (!roomId) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId)) { setError('This invite link is not valid.'); return; }
    try {
      const saved = JSON.parse(sessionStorage.getItem(`couchswarm:${roomId}`) || 'null') as Session | null;
      if (saved?.roomId === roomId && saved.token) { setSession(saved); return; }
    } catch { /* An expired tab credential can be replaced by the invite. */ }
    setInvitation({ roomId, invite });
  }, []);

  // A back/forward-cache restore of a tab that already left brings back a seat the server has released.
  useEffect(() => { const restore = (event: PageTransitionEvent) => { if (event.persisted && leaving.current) location.reload(); }; window.addEventListener('pageshow', restore); return () => window.removeEventListener('pageshow', restore); }, []);

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
    // A tab that cannot hold the seat must not spend the host's re-claim key: the server would crown a tab that never heartbeats.
    if (!await claimSeat(invitation.roomId)) { setError('This room is already open in another CouchSwarm tab.'); return; }
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
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const heartbeat = async () => {
      if (leaving.current) return;
      checkSleep();
      const state = live.current;
      const current = state.snapshot?.room;
      const video = videoRef.current;
      const now = current ? localNow() : 0;
      const target = current ? timelinePosition(current, now) : 0;
      const ahead = video ? bufferedAhead(video.buffered, target) : 0;
      const ready = !!(current && video && anchor.current.server && state.armed && !state.media.error && state.media.loadedVersion === current.mediaVersion
        && appliedEpoch.current === current.epoch && video.readyState >= 2 && !video.seeking
        && Math.abs(video.currentTime - target) < 1.5 && hasBuffer(ahead, target, video.duration, current.playing));
      const sent = performance.now();
      pending.current = true;
      try {
        const data = await request<Snapshot>(`/api/rooms/${session.roomId}`, { action: current ? 'heartbeat' : 'snapshot',
          ready, buffered: ahead, epoch: current?.epoch ?? -1,
          mediaVersion: state.media.loadedVersion, duration: video && Number.isFinite(video.duration) ? video.duration : 0,
          sequence: ++sequence.current,
        }, session.token);
        failures = 0;
        if (!stopped) { const ok = accept(data, sent); if (!ok) setNetworkError('The room sent an unexpected reply. Retrying.'); else if (performance.now() >= controlError.current) setNetworkError(''); }
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
        failures++;
        setNetworkError((err as Error).message);
      } finally { pending.current = false; }
      // Back off a failing room instead of pinning it at 1 Hz, and hold an idle lobby at the watchdog's floor.
      const period = failures ? Math.min(8000, 1000 * 2 ** failures) * (.8 + Math.random() * .4) : live.current.snapshot?.room.source ? 1000 : 2000;
      if (!stopped && !leaving.current) timer = setTimeout(heartbeat, Math.max(0, period - (performance.now() - sent)));
    };
    void claimSeat(session.roomId).then(ok => { if (stopped) return; setRefused(!ok); if (!ok) setError('This room is already open in another CouchSwarm tab.'); else void heartbeat(); });
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, request, accept, videoRef, localNow, checkSleep]);

  useEffect(() => {
    const tick = setInterval(applyRoomState, 100);
    return () => clearInterval(tick);
  }, [applyRoomState]);

  const control = async (action: string, extra: Record<string, unknown> = {}) => {
    const state = live.current;
    if (!state.session) return false;
    if (!state.snapshot) { setError('Still connecting to the room. Try again in a moment.'); return false; }
    setBusy(true); setError('');
    const sent = performance.now();
    try {
      const data = await request<Snapshot>(`/api/rooms/${state.session.roomId}`, { action, revision: state.snapshot.room.revision, ...extra }, state.session.token);
      if (!accept(data, sent)) { setError('The room sent an unexpected reply. Try that again.'); return false; }
      const rotated = data as unknown as { invite?: string; hostKey?: string };
      if (rotated.invite) saveSession({ ...state.session, invite: rotated.invite, ...(rotated.hostKey ? { hostKey: rotated.hostKey } : {}) });
      return true;
    } catch (err) { const status = (err as { status?: number }).status; staleControl.current = status === 409; if (status) setError((err as Error).message); else { controlError.current = performance.now() + 5000; setNetworkError((err as Error).message); } return false; }
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
    // A tab that lost the seat lock shares its token with the tab that holds it: leaving here would take that tab's seat away.
    if (session && !refused) {
      leaving.current = true;
      sendLeave(session);
      try { sessionStorage.removeItem(`couchswarm:${session.roomId}`); } catch { /* Storage blocked: nothing to clear. */ }
    }
    location.assign('/');
  };

  const isHost = room ? room.hostId === session?.memberId : !session;
  const everyoneReady = !!(room && snapshot && allReady(snapshot.members, room, snapshot.serverNow));
  // lastSeen carries the server's clock, so presence is judged against the snapshot's own timestamp, as allReady does.
  const hostPresent = !!(room && snapshot && snapshot.members.some(m => m.id === room.hostId && m.lastSeen > snapshot.serverNow - PRESENCE_MS));
  return { session, room, members: snapshot?.members || [], invitation, error: error || networkError, unsupported, busy, connected, armed, playhead,
    buffered, duration, countdown, media, isHost, everyoneReady, hostPresent, create, join, control, enable, leave,
    inviteUrl: session ? `${typeof location === 'undefined' ? '' : location.origin}/?room=${session.roomId}#invite=${session.invite}` : '',
  };
}
