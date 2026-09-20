'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { allReady, bufferedAhead, estimateServerNow, hasBuffer, PRESENCE_MS, ROOM_TTL_MS, timelinePosition, validSource, type Session, type Snapshot } from '@/lib/sync';
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

// A re-claim key outlives the tab that wrote it by design, but nothing ever took one back, so a device kept an
// entry for every room it had ever hosted. The room behind a key is gone a day after it was created, and a new
// room is the natural moment to sweep: keys stamped longer ago than that, and the unstamped ones that predate
// the stamp, can no longer claim anything.
function pruneHostKeys() {
  try {
    for (const name of Object.keys(localStorage)) {
      if (!name.startsWith('couchswarm:host:')) continue;
      let at = 0;
      try { at = (JSON.parse(localStorage.getItem(name) || 'null') as { at?: number } | null)?.at ?? 0; } catch { /* A bare key from before the stamp. */ }
      if (Date.now() - at > ROOM_TTL_MS) localStorage.removeItem(name);
    }
  } catch { /* Storage blocked: there is nothing stored to prune. */ }
}

const REFUSAL = 'needs a current browser: Chrome or Edge 116+, Firefox 124+, or Safari 17.4+.';

export function useRoom(videoRef: RefObject<HTMLVideoElement | null>) {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invitation, setInvitation] = useState<{ roomId: string; invite: string } | null>(null);
  const [error, setError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [seatLost, setSeatLost] = useState(false);
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
  // Past this much silence the room state is too old to follow, so the element is paused until a reply lands.
  const outOfContact = useCallback(() => performance.now() - lastContact.current > Math.max(3500, 1000 + 2 * rtt.current), []);

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
    if ((!pending.current || performance.now() - lastContact.current > 11000) && outOfContact()) { video.pause(); setConnected(false); return; }
    if (state.media.loadedVersion !== current.mediaVersion || video.readyState < 1) return;
    const now = localNow();
    const target = timelinePosition(current, now);
    // The room's duration is the host's reading of the file, and another demuxer can come up a shade shorter, so
    // the timeline can name a moment this element has no frame for. Correct towards its own end instead: a target
    // it can never reach is a seek on every tick for as long as the room sits there.
    const reachable = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(target, video.duration) : target;
    const drift = reachable - video.currentTime;
    if (performance.now() >= bridged.current.until && (appliedEpoch.current !== current.epoch || Math.abs(drift) > 0.75 || (!current.playing && Math.abs(drift) > .12))) {
      if (!video.seeking) { video.currentTime = reachable; appliedEpoch.current = current.epoch; }
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
  }, [videoRef, localNow, checkSleep, outOfContact]);

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
    const data = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    if (!response.ok) throw Object.assign(new Error(data?.error || 'The room could not be reached. Try again.'), { status: response.status, code: data?.code });
    if (!data) throw new Error('The room could not be reached. Try again.');
    return data as T;
  }, []);

  const saveSession = useCallback((value: Session) => {
    // Only the device's access credential lives here. Room state is authoritative on the server.
    try {
      sessionStorage.setItem(`couchswarm:${value.roomId}`, JSON.stringify(value));
      if (value.hostKey) localStorage.setItem(`couchswarm:host:${value.roomId}`, JSON.stringify({ key: value.hostKey, at: Date.now() }));
    } catch { /* Storage blocked: the seat lives in memory until this tab closes. */ }
    history.replaceState(null, '', `?room=${value.roomId}#invite=${value.invite}`);
    setSession(value);
    setInvitation(null);
    setError('');
  }, []);

  // One state carries two lifetimes: a live control failure, which the next reply or revision clears, and a form's
  // submit failure, which belongs to the form that caused it and has to go when that form does.
  const clearError = useCallback(() => setError(''), []);

  useEffect(() => {
    const roomId = new URLSearchParams(location.search).get('room');
    // Read the link first, so an invitee on a refused browser is told their friend's room is out of reach.
    if (typeof AbortSignal.any !== 'function') { setUnsupported(true); setError(`${roomId ? 'This room' : 'CouchSwarm'} ${REFUSAL}`); return; }
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
    if (!roomId) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId)) { setError('This invite link is not valid.'); return; }
    try {
      const saved = JSON.parse(sessionStorage.getItem(`couchswarm:${roomId}`) || 'null') as Session | null;
      if (saved?.roomId === roomId && saved.token) { setSession(saved); return; }
    } catch { /* An expired tab credential can be replaced by the invite. */ }
    setInvitation({ roomId, invite });
  }, []);

  // Rotation is host-only and no reply carries the new invite, so a guest holding the old link would go on
  // handing out a dead one. The room publishes a tag of its invite's hash instead: this tab hashes the link it
  // is showing the same way and compares. Without subtle crypto there is no tag, and the link stays on screen.
  // The digest lands a tick after the invite it belongs to, so the invite is remembered beside it: a tag left over
  // from the link this tab has just rotated away would read as stale against the room that has already caught up.
  const [hashed, setHashed] = useState({ invite: '', tag: '' });
  const sessionInvite = session?.invite;
  useEffect(() => {
    if (!sessionInvite || !crypto.subtle) return;
    let current = true;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionInvite))
      .then(digest => { if (current) setHashed({ invite: sessionInvite, tag: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 16) }); })
      .catch(() => { /* No digest, no staleness check. */ });
    return () => { current = false; };
  }, [sessionInvite]);

  // A back/forward-cache restore of a tab that already left brings back a seat the server has released.
  useEffect(() => { const restore = (event: PageTransitionEvent) => { if (event.persisted && leaving.current) location.reload(); }; window.addEventListener('pageshow', restore); return () => window.removeEventListener('pageshow', restore); }, []);

  const create = (source = '', name = '') => {
    // Every new room is born here, so the refusal is enforced here too: a created room would wipe it off the
    // screen and leave a host whose browser cannot load the movie.
    if (unsupported) { setError(`CouchSwarm ${REFUSAL}`); return Promise.resolve(false); }
    if (creating.current) { setError('Still creating the room. Try again in a moment.'); return Promise.resolve(false); }
    creating.current = (async () => {
      if (source && !validSource(source.trim())) { setError('Enter a valid magnet link or HTTPS .torrent URL.'); return false; }
      setBusy(true); setError('');
      pruneHostKeys();
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
    // A corrected link pasted into this tab only changes the fragment, which never remounts the hook, so join
    // with whatever invite the address bar holds now rather than the one read at load.
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite') || invitation.invite;
    let hostKey: string | undefined;
    // A key stored before the prune stamp is the bare secret.
    try {
      const stored = localStorage.getItem(`couchswarm:host:${invitation.roomId}`) || '';
      hostKey = (stored.startsWith('{') ? (JSON.parse(stored) as { key?: string }).key : stored) || undefined;
    } catch { /* Blocked or unreadable storage only costs the host their re-claim. */ }
    try { saveSession(await request<Session>(`/api/rooms/${invitation.roomId}`, { action: 'join', name, invite, hostKey })); }
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
        && appliedEpoch.current === current.epoch
        // A hard resync into data this element already holds still raises seeking and drops readyState for a few
        // tens of milliseconds, and a heartbeat that lands inside that window pauses the room for everyone. While
        // the room plays, buffer at the target is proof enough; a paused member still has to decode the frame it
        // is being asked to show before a countdown starts.
        && ((current.playing && ahead > 0) || (video.readyState >= 2 && !video.seeking))
        // An element this tab paused itself is behind the timeline through no fault of its buffer, and the
        // reply to this very request seeks it back, so buffer at the target still counts as ready. One sitting
        // at its own end has nowhere further to go, which is all the room asks of it at the wrap.
        && (Math.abs(video.currentTime - target) < 1.5 || (outOfContact() && ahead > 0) || (video.ended && target >= video.duration - 0.2))
        && hasBuffer(ahead, target, video.duration, current.playing));
      const sent = performance.now();
      pending.current = true;
      try {
        const data = await request<Snapshot>(`/api/rooms/${session.roomId}`, { action: current ? 'heartbeat' : 'snapshot',
          ready, buffered: ahead, epoch: current?.epoch ?? -1,
          mediaVersion: state.media.loadedVersion, duration: video && Number.isFinite(video.duration) ? video.duration : 0,
          sequence: ++sequence.current,
        }, session.token);
        failures = 0;
        if (!stopped) { setSeatLost(false); const ok = accept(data, sent); if (!ok) setNetworkError('The room sent an unexpected reply. Retrying.'); else if (performance.now() >= controlError.current) setNetworkError(''); }
      } catch (err) {
        if (stopped) return;
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 404 || status === 410) {
          try { sessionStorage.removeItem(`couchswarm:${session.roomId}`); } catch { /* Storage blocked: nothing to clear. */ }
          const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
          setSession(null); setSnapshot(null); setConnected(false);
          // The dialog that comes back is the one a first-time invitee sees, so without a reason beside it a seat
          // that was just taken away reads as a fresh welcome.
          if (status === 401 && invite) { setInvitation({ roomId: session.roomId, invite }); setError('You are no longer in this room. You can join again with the same link.'); }
          else setError((err as Error).message);
          return;
        }
        // A seat someone else took while this tab was away is not a connection to repair: the retry below is what
        // takes it back, so it stays, but the room must stop reading as 'reconnecting' with this tab still seated.
        setSeatLost(status === 409 && (err as { code?: string }).code === 'seat-lost');
        failures++;
        setNetworkError((err as Error).message);
      } finally { pending.current = false; }
      // Back off a failing room instead of pinning it at 1 Hz, and hold an idle lobby at the watchdog's floor.
      // Only once the presence lease has lapsed, though: backing off sooner puts the retry that would have kept
      // the seat alive on the far side of the lease, which pauses the room for everyone with a reason that the
      // host - already back by then - has to clear by hand.
      const period = failures && performance.now() - lastContact.current > PRESENCE_MS ? Math.min(8000, 1000 * 2 ** failures) * (.8 + Math.random() * .4) : live.current.snapshot?.room.source ? 1000 : 2000;
      if (!stopped && !leaving.current) timer = setTimeout(heartbeat, Math.max(0, period - (performance.now() - sent)));
    };
    void claimSeat(session.roomId).then(ok => { if (stopped) return; setRefused(!ok); if (!ok) setError('This room is already open in another CouchSwarm tab.'); else void heartbeat(); });
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, request, accept, videoRef, localNow, checkSleep, outOfContact]);

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
  const inviteStale = !!room?.inviteTag && hashed.invite === sessionInvite && room.inviteTag !== hashed.tag;
  return { session, room, members: snapshot?.members || [], invitation, error: error || networkError, unsupported, busy, connected, armed, playhead,
    buffered, duration, countdown, media, isHost, everyoneReady, hostPresent, inviteStale, seatLost, create, join, control, enable, leave, clearError,
    inviteUrl: session ? `${typeof location === 'undefined' ? '' : location.origin}/?room=${session.roomId}#invite=${session.invite}` : '',
  };
}
