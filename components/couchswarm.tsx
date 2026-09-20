'use client';
import { HelperConnection } from '@/components/helper-connection';

import { useEffect, useRef, useState, useSyncExternalStore, type SyntheticEvent } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowDown, ArrowRight, Check, CircleHelp, Copy, Crown, Film, Link2, LoaderCircle, LockKeyhole, LogOut, Maximize, MonitorPlay, Pause, Play, Radio, ShieldCheck, Sofa, Users, Volume2, VolumeX, Wifi, Zap } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { useRoom } from '@/hooks/use-room';
import { BUFFER_SECONDS, MAX_SEATS, ROOM_TTL_MS, SPECTATOR_EPOCH } from '@/lib/sync';

function time(seconds: number) {
  if (!Number.isFinite(seconds)) return '--:--';
  const value = Math.floor(Math.max(0, seconds));
  return `${value >= 3600 ? `${Math.floor(value / 3600)}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
function bytes(value: number) {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(2)} GB`;
}
// A deploy replaces the hashed chunk names, so a room open across one asks for a picker chunk this site no
// longer serves. Rendering that failure in place of the picker keeps the rest of the room — the heartbeat
// that holds this seat included — rather than handing the whole page to the error boundary.
function PickerUpdated() {
  return <div className="error" role="alert">CouchSwarm was updated while this room was open. <button className="quiet-button" onClick={() => location.reload()}>Reload this page</button> to choose a video or subtitle. Your seat is kept.</div>;
}
const updated = () => PickerUpdated as never;
// Hydration happens once and never comes undone, so this store has nothing to report.
const noUpdates = () => () => { /* Nothing to unsubscribe from. */ };
// Only multi-file torrents need the picker, so its base-ui Select stays out of the first-load bundle.
const VideoSelection = dynamic(() => import('@/components/video-selection').then(m => m.VideoSelection).catch(updated), { ssr: false });
const SubtitleSelection = dynamic(() => import('@/components/subtitle-selection').then(m => m.SubtitleSelection).catch(updated), { ssr: false });

export default function CouchSwarm() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekInFlight = useRef(false);
  const nextSeek = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastToggle = useRef(0);
  const helpRef = useRef<HTMLButtonElement>(null);
  const inviteRef = useRef<HTMLButtonElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const couchRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const magnetRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const swarm = useRoom(videoRef);
  const { room, media, session, isHost, members } = swarm;
  const [openDialog, setModal] = useState<'help' | 'invite' | 'source' | 'helper' | null>(null);
  const [magnet, setMagnet] = useState('');
  const [loadingTorrent, setLoadingTorrent] = useState(false);
  const [formError, setFormError] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [hostName, setHostName] = useState('');
  const [muted, setMuted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [seek, setSeek] = useState<number | null>(null);
  const [volume, setVolume] = useState(1);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [rotated, setRotated] = useState(false);
  // A rotate that comes back an error may still have committed: the row is written before the reply is assembled,
  // and the new invite exists nowhere but that reply. So a failed one leaves no link worth copying, only a retry.
  const [rotateFailed, setRotateFailed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The prerendered form carries no submit handler, so Enter would navigate to /?torrent=… - losing the magnet
  // to the address bar and history, and with it the ?room= of an invite link, which leaves a guest in a host lobby.
  const hydrated = useSyncExternalStore(noUpdates, () => true, () => false);
  // A lost seat takes every dialog with it: nothing behind the join dialog can be reached anyway, and the helper
  // one - which unmounts with the session - would otherwise spring open by itself the moment the guest rejoined.
  const modal = swarm.invitation ? null : openDialog;
  const hasSource = !!room?.source;
  const isPlaying = !!room?.playing;
  const canPlay = hasSource && swarm.connected && isHost && !swarm.busy && (isPlaying || swarm.everyoneReady);
  const readyCount = members.filter(m => m.ready && m.epoch === room?.epoch).length;
  const seatedCount = members.filter(m => m.epoch !== SPECTATOR_EPOCH).length;
  // A tab whose seat was taken cannot refresh anything: its last snapshot still shows a full couch with itself on it.
  const displayMembers = swarm.seatLost ? [] : session ? members.slice().sort((a, b) => Number(b.id === room?.hostId) - Number(a.id === room?.hostId) || Number(b.id === session.memberId) - Number(a.id === session.memberId)) : [{ id: 'you', name: 'You', ready: false, buffered: 0, epoch: -1, lastSeen: 0 }];
  // A rebuilt pipeline (a helper reconnect, 'Reconnect to movie') keeps the room's media version, so the
  // duration of the video that has just been emptied is still on screen. Treat that wait like any other:
  // the overlay carrying the status text is the only place it is reported, and the slider means nothing yet.
  const reloading = hasSource && media.loadedVersion !== room?.mediaVersion;
  const showEnable = hasSource && !media.error && swarm.duration > 0 && !swarm.armed && !reloading;
  const waitingOnSource = hasSource && !media.error && (swarm.duration === 0 || reloading);
  const seekLost = !hasSource || !isHost || !swarm.duration || !swarm.connected || reloading;
  const formVisible = modal === 'source' || (!hasSource && isHost && !swarm.invitation);
  // Only a playing room is given a host-away reason by the server, so a guest left behind in a lobby or a
  // paused room has nothing but the missing crowned entry to go on. Presence is polled anyway: say it.
  const hostAway = !!room && !isHost && swarm.connected && !swarm.hostPresent;
  const hostAwayNote = 'Your host has stepped away. The room picks up when they return.';
  const playHint = hostAway ? 'Your host has stepped away' : !isHost ? 'Your host controls the room' : !swarm.everyoneReady && !isPlaying ? 'Waiting for everyone to buffer' : 'You control the room';
  const announcement = hasSource && swarm.countdown > 0 && swarm.armed ? `Starting in ${swarm.countdown}` : swarm.seatLost ? 'Your seat was taken. Waiting for a free seat.' : !swarm.connected && session ? (room ? 'Connection lost, reconnecting' : 'Connecting to the room') : swarm.error || (hostAway ? hostAwayNote : room?.reason) || '';
  // .player-card is the fullscreen element, so the pause reason beside it and the error box below it cannot be
  // seen from fullscreen, and a control that failed changes nothing near the button anywhere. The in-card notice
  // already paints over the video, so the text that explains a stopped movie goes there too.
  const playerMessage = swarm.error && !swarm.invitation && !formVisible ? swarm.error
    : isFullscreen && hasSource && !isPlaying ? room?.reason || '' : '';
  // canPlay already requires the host, so both the button and the space bar reach the room only for them.
  const togglePlayback = () => {
    // Wall time can step backwards - an NTP correction after a resume, say - and every toggle from then until the
    // clock catches up reads as one that has just happened. performance.now() only ever moves forward.
    if (!canPlay || performance.now() - lastToggle.current < 400) return;
    lastToggle.current = performance.now();
    void swarm.control(isPlaying ? 'pause' : 'play');
  };
  // Two clicks on the timeline before the first reply lands carry the same room revision, so the server takes the
  // first and refuses the second with 'The room changed', and the thumb springs back to a place nobody asked for.
  // Hold the later position and send it once the one in flight settles, so the last place the host chose wins.
  const sendSeek = (position: number) => {
    if (seekInFlight.current) { nextSeek.current = position; return; }
    seekInFlight.current = true;
    void swarm.control('seek', { position }).finally(() => {
      seekInFlight.current = false;
      const queued = nextSeek.current;
      nextSeek.current = null;
      if (queued === null) setSeek(null); else sendSeek(queued);
    });
  };

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 3500);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => { if (seekLost) { clearTimeout(seekTimer.current); nextSeek.current = null; setSeek(null); } }, [seekLost]);
  // The rejoin dialog portals to the body, outside the fullscreen player card, so it cannot paint until we leave.
  useEffect(() => { if (swarm.invitation && document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }, [swarm.invitation]);
  useEffect(() => { const on = () => setIsFullscreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', on); return () => { document.removeEventListener('fullscreenchange', on); clearTimeout(hideTimer.current); }; }, []);
  // Space is the usual play key, but it also types, presses buttons and nudges sliders, so it reaches the
  // room only from an idle page. Re-bound each render so it always closes over the current room state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A widget that has already acted on this Space - choosing a track in an open picker, say - calls
      // preventDefault without stopping the event, so it still arrives here.
      if (event.defaultPrevented || event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || modal || swarm.invitation) return;
      // A mouse seek leaves focus inside the timeline slider, where Space does nothing of its own, so the
      // room still hears it from there.
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, [contenteditable], [role=slider], [role=dialog], [role=option], [role=listbox]') && !target.closest('.timeline')) return;
      if (!canPlay) return;
      event.preventDefault();
      togglePlayback();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // A dialog can be opened from more than one place, so closing it returns to the control that was pressed
  // rather than to whichever one the ref happens to name. Each dialog keeps its own ref as the fallback.
  // Safari leaves a clicked button unfocused, so the body is not an opener worth returning to.
  const rememberOpener = () => { const active = document.activeElement; openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null; };
  async function invite() {
    rememberOpener();
    if (!session && !await swarm.create('', hostName)) return;
    setCopied(false); setCopyError(''); setRotated(false); setRotateFailed(false);
    setModal('invite');
  }
  // Removing someone deletes their row but leaves the invite that let them in, so the link in their address bar
  // puts them straight back - and every join pauses the room. Rotating is the only revocation, and it empties the
  // whole couch, so it stays a deliberate second button. The kick goes first: if the rotate is refused, the person
  // the host named is still out.
  async function remove(member: { id: string; name: string }, resetLink: boolean) {
    if (swarm.busy) return;
    if (!await swarm.control('kick', { memberId: member.id })) return;
    if (resetLink && !await swarm.control('rotate')) return;
    couchRef.current?.focus();
    setFeedback(resetLink ? `${member.name} is out and the couch has a new invite link. Everyone else rejoins with it.`
      : `${member.name} was removed. They can rejoin with the current link until you create a new one.`);
  }
  async function submitTorrent(event: SyntheticEvent) {
    event.preventDefault();
    if (loadingTorrent || swarm.busy) return;
    const source = magnet.trim();
    if (!source) return;
    setLoadingTorrent(true);
    try {
      const ok = session ? await swarm.control('source', { source }) : await swarm.create(source, hostName);
      setFormError(!ok);
      // The lobby form unmounts with the movie loaded, taking the focused input with it; the dialog's own
      // finalFocus already covers the other way in.
      if (ok) { const lobby = modal !== 'source'; setModal(null); setMagnet(''); if (lobby) headingRef.current?.focus(); }
    } finally { setLoadingTorrent(false); }
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(swarm.inviteUrl); setCopied(true); setCopyError(''); }
    catch { setCopyError('Select the invite link and copy it manually.'); }
  }
  async function fullscreen() {
    const card = playerRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (card?.requestFullscreen) await card.requestFullscreen();
      else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else throw new Error('unsupported');
    } catch { setFeedback('Fullscreen is unavailable in this browser view.'); }
  }
  async function openModal(next: typeof modal) {
    rememberOpener();
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* The dialog still needs to open. */ } }
    setModal(next);
  }
  // Clicking a player button leaves it focused, and in fullscreen it fades to invisible with the rest of the
  // bar; the next Space then presses that button again - leaving fullscreen, or toggling mute - instead of
  // reaching the room. Keeping the click off the focus ring costs nothing: Tab still focuses these buttons.
  const keepFocus = (event: SyntheticEvent) => event.preventDefault();
  function revealControls() {
    const card = playerRef.current;
    if (!card || !isFullscreen) return;
    if (!('active' in card.dataset)) card.dataset.active = '';
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { delete card.dataset.active; }, 2500);
  }

  const torrentForm = <><form className="torrent-form" onSubmit={submitTorrent}><Link2 size={18}/><input name="torrent" ref={magnetRef} id={modal === 'source' ? 'change-torrent' : 'torrent'} aria-label="Torrent magnet link or HTTPS torrent URL" placeholder="Paste a magnet or torrent link…" value={magnet} onChange={e => setMagnet(e.target.value)} required maxLength={8192} autoComplete="off" disabled={!hydrated || swarm.unsupported} aria-invalid={formError && swarm.error ? true : undefined} aria-describedby={formError && swarm.error ? 'torrent-error' : undefined}/><button className="primary-button" disabled={!hydrated || swarm.unsupported} aria-busy={loadingTorrent || swarm.busy}>{loadingTorrent ? <><LoaderCircle size={16} className="spin"/><span className="sr-only">{session ? 'Loading torrent' : 'Creating room'}</span></> : <>{session ? 'Load torrent' : 'Create room'}<ArrowRight size={16}/></>}</button></form>{swarm.error && <div id="torrent-error" className="error" role="alert">{swarm.error}</div>}</>;

  return <div className="shell">
    <output className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</output>
    <output className="sr-only" aria-live="polite" aria-atomic="true">{hasSource && !isPlaying && swarm.everyoneReady ? (isHost ? 'Everyone is ready. You can press play.' : 'Everyone is ready.') : ''}</output>
    <header className="topbar"><Link href="/" className="brand" onClick={e => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); if (!session || confirm('Leave the room? You will lose your seat in this tab.')) swarm.leave(); }}><span className="brand-mark"><Sofa size={27} strokeWidth={1.8}/></span>CouchSwarm</Link><div className="top-actions"><span className="top-caption"><span>●</span> DIFFERENT COUCHES. SAME MOMENT.</span><button className="quiet-button" ref={helpRef} onClick={() => setModal('help')}><CircleHelp size={16}/> How it works</button>{session && <button className="icon-button" aria-label="Leave room" title="Leave room" onClick={() => { if (confirm('Leave the room? You will lose your seat in this tab.')) swarm.leave(); }}><LogOut size={18}/></button>}</div></header>
    <main>
      <div className="room-heading"><div><div className="eyebrow"><span className={`dot ${swarm.connected || !session ? 'live' : ''}`}/>{session ? `ROOM ${session.roomId.slice(0, 8).toUpperCase()}` : 'YOUR OWN LITTLE CINEMA'}</div><h1 tabIndex={-1} ref={headingRef}>The living room</h1></div><div className="heading-actions"><span className="pill"><LockKeyhole size={12}/> Invite only</span><button className="primary-button" ref={inviteRef} aria-busy={swarm.busy} onClick={() => { if (!swarm.busy) void invite(); }} disabled={!!swarm.invitation || swarm.unsupported}><Users size={16}/> Invite friends <ArrowRight size={15}/></button></div></div>
      <div className="workspace"><section aria-label="Room player">
        <div className="player-card" ref={playerRef} onPointerMove={revealControls}>
          <div className="screen">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- each viewer attaches their own track at runtime, so there is none to declare here. */}
            <video ref={videoRef} playsInline preload="auto" muted={muted} disablePictureInPicture aria-label="Shared room video" style={{ visibility: hasSource ? 'visible' : 'hidden' }}/>
            <span className="screen-label"><Radio size={13}/>{!session ? 'ROOM STANDBY' : swarm.seatLost ? 'WAITING FOR A SEAT' : !swarm.connected ? 'CONNECTING' : !hasSource ? 'ROOM OPEN' : isPlaying ? 'WATCHING TOGETHER' : waitingOnSource ? 'GETTING READY' : 'ROOM PAUSED'}</span>
            {!hasSource && <div className="setup"><div className="setup-icon"><Sofa size={34} strokeWidth={1.3}/></div><h2>{isHost ? <>Good company.<br/><span>Great movie night.</span></> : swarm.seatLost ? <>The couch filled up.<br/><span>We’ll bring you back.</span></> : <>You’re on the couch.<br/><span>The movie’s up next.</span></>}</h2><p>{isHost ? <>Drop a torrent, invite your people, and press play.<br/>We’ll keep everyone watching together.</> : swarm.seatLost ? 'Someone took your seat while you were away. You’ll be seated again the moment one opens.' : hostAway ? hostAwayNote : 'Your host is choosing a movie. Make yourself at home.'}</p>{isHost && !swarm.invitation && modal !== 'source' && <>{!session && <input className="text-input" aria-label="Your name" placeholder="Your name (optional)" value={hostName} onChange={e => setHostName(e.target.value)} maxLength={24} autoComplete="name"/>}{torrentForm}<p className="format-note">Magnet links · MKV, MP4 & WebM · Subtitles</p></>}</div>}
            {waitingOnSource && <div className="status-overlay"><LoaderCircle size={30} className="spin"/><h2>Getting the movie ready</h2><p><output>{media.status || 'Connecting to the torrent swarm…'}</output></p>{!media.helper && !media.helperPending && <><p className="overlay-hint">{isHost ? 'Most torrents need the CouchSwarm helper to reach ordinary peers. Without one, only WebRTC seeders and web seeds can reach this room.' : 'Nobody is running a helper yet. You can run your own to reach ordinary torrent peers.'}</p><button className="primary-button" onClick={() => void openModal('helper')}><MonitorPlay size={16}/> Set up the helper</button></>}</div>}
            {showEnable && <div className="status-overlay"><Play size={27}/><h2>Your seat is saved.</h2><p>{isHost ? 'Enable playback on this device, then press play once everyone is ready.' : 'Enable playback on this device. The host will start the movie when everyone is ready.'}</p><button className="primary-button" onClick={() => void swarm.enable().then(() => headingRef.current?.focus())}>I’m ready to watch <ArrowRight size={15}/></button></div>}
            {hasSource && media.error && <div className="status-overlay" role="alert"><Film size={29}/><h2>This movie needs a little help</h2><p>{media.error}</p><button className="primary-button" onClick={() => { media.reconnect(); headingRef.current?.focus(); }}>Reconnect to movie</button>{isHost && <button className="outline-button" onClick={() => void openModal('source')}>Try another torrent</button>}</div>}
            {hasSource && swarm.countdown > 0 && swarm.armed && <div className="status-overlay countdown"><span>{swarm.countdown}</span><p>Everybody’s here. Here we go.</p></div>}
            {!hasSource && <span className="screen-corner">MAKE YOURSELF AT HOME.</span>}
          </div>
          <div className="player-controls">
            <div className="timeline"><span className="time">{time(seek ?? swarm.playhead)}</span><Slider aria-label="Playback position" getAriaValueText={(_, v) => time(v)} value={[seek ?? swarm.playhead]} min={0} max={swarm.duration || 1} step={1} disabled={seekLost} onValueChange={value => setSeek(Array.isArray(value) ? value[0] : value)} onValueCommitted={(value, details) => { const position = Array.isArray(value) ? value[0] : value; const send = () => sendSeek(position); clearTimeout(seekTimer.current); if (details.reason === 'keyboard') seekTimer.current = setTimeout(send, 400); else send(); }}/><span className="time">{swarm.duration ? time(swarm.duration) : '--:--'}</span></div>
            <div className="control-row"><div className="control-group"><button className="play-button" onMouseDown={keepFocus} aria-disabled={!canPlay} aria-describedby="play-hint" title={isHost ? `${isPlaying ? 'Pause' : 'Play'} for everyone (space)` : undefined} onClick={togglePlayback}>{isPlaying ? <Pause size={15} fill="currentColor"/> : <Play size={15} fill="currentColor"/>}{isPlaying ? 'Pause for all' : 'Play for all'}</button><div className="volume-control" onMouseEnter={() => setVolumeOpen(true)} onMouseLeave={e => { /* A mouse click on Mute, or a drag of the thumb, leaves focus in here; only a keyboard visitor needs the popover held open over the seek bar. */ if (!e.currentTarget.querySelector(':focus-visible')) setVolumeOpen(false); }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setVolumeOpen(false); }}><button className="icon-button" onMouseDown={keepFocus} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute; volume slider opens above' : 'Mute; volume slider opens above'} onClick={() => { if (!muted) { setMuted(true); return; } const v = volume > 0 ? volume : .5; setVolume(v); if (videoRef.current) videoRef.current.volume = v; setMuted(false); }} onFocus={() => setVolumeOpen(true)}>{muted ? <VolumeX size={19}/> : <Volume2 size={19}/>}</button>{volumeOpen && <div className="volume-slider"><Slider aria-label="Your volume" getAriaValueText={(_, v) => `${Math.round(v * 100)}%`} value={[muted ? 0 : volume]} min={0} max={1} step={.01} largeStep={.1} onValueChange={value => { const v = Array.isArray(value) ? value[0] : value; setVolume(v); setMuted(v === 0); if (videoRef.current) videoRef.current.volume = v; }}/></div>}</div><span className="control-hint" id="play-hint"><Crown size={13}/>{playHint}</span></div><div className="control-group"><span className="pill"><span className={`dot ${swarm.everyoneReady ? 'live' : ''}`}/>{swarm.seatLost ? 'Seat taken' : !hasSource ? 'Waiting for a movie' : !swarm.connected ? 'Reconnecting' : isPlaying ? 'In sync' : swarm.everyoneReady ? 'Everyone ready' : hostAway ? 'Host away' : 'Buffering'}</span><button className="icon-button" onMouseDown={keepFocus} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={isFullscreen} onClick={() => void fullscreen()}><Maximize size={18}/></button></div></div>
          </div>
          <output className="notice">{feedback || playerMessage}</output>
        </div>
        <div className="room-info"><span className="file-icon"><Film size={21}/></span><div className="file-info"><h2 title={media.stats.filename}>{media.stats.filename || (hasSource ? 'Finding your movie…' : 'Your next movie night starts here')}</h2><p>{media.stats.filename ? `${bytes(media.stats.size)} · ${Math.round(media.stats.progress * 100)}% downloaded · Sequential streaming` : hasSource ? 'Looking for video metadata and available peers.' : 'Add a torrent to get the room rolling.'}</p></div>{isHost && <button className="quiet-button" ref={changeRef} onClick={() => hasSource ? void openModal('source') : document.getElementById('torrent')?.focus()}><Link2 size={14}/>{hasSource ? 'Change' : 'Add torrent'}</button>}</div>
        {media.files.length > 1 && <VideoSelection files={media.files} value={room?.fileIndex || 0} disabled={!isHost} onChange={next => { if (swarm.busy) return; if (next !== (room?.fileIndex || 0)) void swarm.control('file', { fileIndex: next }); }}/>}
        {hasSource && <SubtitleSelection subtitles={media.subtitles} value={media.subtitle} busy={media.subtitleBusy} error={media.subtitleError} onChange={media.setSubtitle}/>}
        <div className="readiness"><ShieldCheck size={22}/><div><strong>{!hasSource ? 'Everyone ready. Then, action.' : swarm.everyoneReady ? isPlaying ? 'Different couches. One shared moment.' : 'All seats ready. Let’s roll.' : 'A good movie is worth the wait.'}</strong><p>{!hasSource ? 'Playback waits for everyone to buffer. No one gets left behind.' : hostAway ? hostAwayNote : room?.reason || 'Everyone needs a little buffer before the host can press play.'}</p></div><span className="pill"><Zap size={12}/>{hasSource ? `${readyCount}/${seatedCount} ready` : 'In sync'}</span></div>
        {swarm.error && !swarm.invitation && !formVisible && <div className="error" role="alert">{swarm.error}</div>}
      </section>
      <aside className="side-column">
        <div className="side-panel"><div className="side-heading"><h2>On the couch <span className="count">{swarm.seatLost ? MAX_SEATS : displayMembers.length}</span></h2><Users size={17} color="#8e9e83"/></div><div className="members">{displayMembers.map(member => {
          const self = member.id === session?.memberId || !session;
          const host = member.id === room?.hostId || !session;
          const ready = member.ready && member.epoch === room?.epoch;
          return <div className="member" key={member.id}><div className="member-top"><div className={`avatar ${host ? '' : 'guest'}`}>{self ? 'Y' : (Array.from(member.name)[0] ?? '?').toUpperCase()}</div><div className="member-name">{self ? 'You' : member.name} {self && <span>(that’s you)</span>}</div>{host ? <span className="member-role"><Crown size={12}/> Host</span> : ready ? <Check size={15} color="#c2f28a"/> : <span className="dot"/>}{isHost && !host && <><button className="quiet-button" aria-label={`Remove ${member.name}`} aria-busy={swarm.busy} onClick={() => void remove(member, false)}>Remove</button><button className="quiet-button" aria-label={`Remove ${member.name} and create a new invite link`} aria-busy={swarm.busy} onClick={() => void remove(member, true)}>Remove and reset link</button></>}</div><div className="member-status"><span>{!hasSource ? 'Waiting for a torrent' : ready ? 'Ready to watch' : self && showEnable ? 'Enable playback' : member.epoch === SPECTATOR_EPOCH ? 'Catching up' : member.buffered >= BUFFER_SECONDS ? 'Getting ready' : 'Buffering'}</span><span>{hasSource ? `${Math.floor(member.buffered)}s` : '—'}</span></div><Progress value={hasSource ? Math.min(100, member.buffered / BUFFER_SECONDS * 100) : 0} aria-label={`${self ? 'Your' : member.name + "’s"} playback buffer`}/></div>;
        })}</div><div className="empty-guests">{displayMembers.length <= 1 && <><Sofa size={31} strokeWidth={1.1}/><p>{swarm.seatLost ? <>The couch is full right now.<br/>You’ll be seated as soon as someone leaves.</> : <>There’s room for your people.<br/>Movie nights are better together.</>}</p></>}<button className="outline-button" ref={couchRef} aria-busy={swarm.busy} onClick={() => { if (!swarm.busy) void invite(); }} disabled={!!swarm.invitation || swarm.unsupported}><Link2 size={15}/> Invite to the couch</button></div><div className="room-note"><LockKeyhole size={14}/><span>Only people with your invite link can join. Up to {MAX_SEATS} seats, for {ROOM_TTL_MS / 3600000} hours after the room is created.</span></div></div>
        {session && <HelperConnection session={session} isHost={isHost} reconnect={media.reconnect} needed={hasSource && !media.helper && !media.helperPending} open={modal === 'helper'} onOpenChange={open => setModal(open ? 'helper' : null)}/>}<div className="connection"><h3>Your connection</h3><div className="stat"><span><Radio size={14}/> Torrent source</span><strong>{media.helper?.host ? 'Host’s helper' : media.helper ? 'Your helper' : media.helperPending ? 'Connecting to helper…' : 'Browser peers'}</strong></div><div className="stat"><span><Wifi size={14}/> Room</span><strong>{swarm.seatLost ? 'Waiting for a seat' : swarm.connected ? 'Connected' : session ? 'Reconnecting' : 'Not connected'}</strong></div><div className="stat"><span><ArrowDown size={14}/> Download</span><strong>{bytes(media.stats.speed)}/s</strong></div><div className="stat"><span><Users size={14}/> Torrent peers</span><strong>{media.helper?.peers ?? media.stats.peers}</strong></div><div className="stat"><span><MonitorPlay size={14}/> Buffered ahead</span><strong>{Math.floor(swarm.buffered)} sec</strong></div></div><p className="side-caption">A shared moment, without sharing a screen.<br/>Streamed directly to every couch.</p>
      </aside></div>
    </main>
    <footer className="footer"><span><Sofa size={14}/> A little less distance. A lot more movie night.</span><span><ShieldCheck size={13}/> Peer-to-peer streaming <span>·</span> Always together</span><span className="footer-meta"><a className="footer-link" href="https://github.com/TypicalHog/couchswarm" target="_blank" rel="noreferrer"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.23 0 4.63-2.8 5.65-5.48 5.95.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/></svg>GitHub</a><span>·</span><span>Created by TypicalHog, 2026</span><span>·</span><a className="footer-link" href="https://github.com/TypicalHog/couchswarm/blob/main/LICENSE.md" target="_blank" rel="noreferrer">Unlicense / MIT / Apache-2.0</a><span>·</span><span>v{process.env.NEXT_PUBLIC_VERSION}</span></span></footer>
    <p className="disclaimer">CouchSwarm is a player for torrents you choose. It hosts, indexes and provides no content, and its creator does not endorse using it to share or stream anything you have no right to.</p>

    <Dialog open={modal === 'help'} onOpenChange={open => !open && setModal(null)}><DialogContent className="modal" finalFocus={helpRef}><DialogHeader><DialogTitle>Settle in. Sync up.</DialogTitle><DialogDescription>Your movie night, in three small steps.</DialogDescription></DialogHeader><div className="help-steps">{[['Pick something good','Paste a magnet or a .torrent URL. Each person downloads their own copy from the swarm.'],['Save them a seat','Share your invite link. Friends join with a name and enable playback on their device.'],['Press play, together','Once everyone has eight seconds buffered (or the remaining video), the host can play, pause, or seek for the room.']].map(([title,desc],i) => <div className="help-step" key={title}><span className="step-number">0{i+1}</span><div><strong>{title}</strong><p>{desc}</p></div></div>)}</div><p className="help-limit">MKV, MP4, and WebM are supported with WebRTC seeders or web seeds. MKV containers are remuxed and common audio formats converted in your browser when needed; the device must still support the video codec. Anyone can download and pair the CouchSwarm helper to reach ordinary torrent peers; the host’s helper serves everyone who doesn’t run their own. Without one, a WebRTC seeder or HTTPS web seed is needed. Downloaded pieces are shared back to the swarm. Keep the room tab open; if a connection stalls, playback pauses and resumes on its own three seconds after everyone is ready again — the host can pause inside that countdown to hold the room. Subtitles are yours alone: choose a subtitle file included in the torrent or upload one from your device, and everyone else keeps whatever they chose. SRT, ASS, SSA and VTT files are read on your device; a subtitle track stored inside the MKV itself is not offered, because reading one would mean demuxing the whole movie ahead of your seat. Keep the movie in one tab: a second CouchSwarm tab in the same browser is refused.</p></DialogContent></Dialog>
    <Dialog open={modal === 'invite'} onOpenChange={open => !open && setModal(null)}><DialogContent className="modal" finalFocus={() => openerRef.current?.isConnected ? openerRef.current : inviteRef.current}><DialogHeader><DialogTitle>Save them a seat.</DialogTitle><DialogDescription>{swarm.inviteStale ? 'The link this tab is holding has been replaced.' : 'Send this link to your people. Everyone who has it can join your room.'}</DialogDescription></DialogHeader>{swarm.inviteStale ? <p className="help-limit">Your host created a new invite link, so the one you joined with no longer lets anybody in. Ask them for the current one.</p> : <><label htmlFor="invite-link">Your room’s invite link</label><div className="invite-link"><input id="invite-link" className="text-input" readOnly value={rotateFailed ? '' : swarm.inviteUrl} placeholder="Press Create a new invite link again" onFocus={e => e.target.select()}/><button className="primary-button" disabled={rotateFailed} onClick={() => void copyInvite()}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Copied' : 'Copy'}</button></div></>}{copyError && <div className="error" role="alert">{copyError}</div>}{swarm.error && <div className="error" role="alert">{swarm.error}</div>}{isHost && <button className="quiet-button" aria-busy={swarm.busy} onClick={() => { if (swarm.busy) return; setCopied(false); setCopyError(''); setRotated(false); setRotateFailed(false); void swarm.control('rotate').then(ok => { setRotated(ok); setRotateFailed(!ok); }); }}>Create a new invite link</button>}<p className="help-limit"><output>{rotated ? 'New link created. The old link no longer works, so copy this one. ' : ''}</output>Up to {MAX_SEATS} people. {isHost ? `Your room stays open for ${ROOM_TTL_MS / 3600000} hours after you create it.` : `The room stays open for ${ROOM_TTL_MS / 3600000} hours after the host creates it.`} The host keeps control of play, pause, and seeking.{isHost && ' Creating a new link empties the couch — everyone else rejoins with the new link — and reissues host control to this device.'}</p></DialogContent></Dialog>
    {/* A refused torrent is the dialog's own failure, but it lands in the room's shared error, where nothing but
        another control action takes it back: it outlived the dialog under the player and turned up again inside
        Invite friends. Dismissing the dialog takes the attempt with it - the message, the field and the mark on it. */}
    <Dialog open={modal === 'source'} onOpenChange={open => { if (open) return; setModal(null); setMagnet(''); setFormError(false); swarm.clearError(); }}><DialogContent className="modal" initialFocus={magnetRef} finalFocus={() => openerRef.current?.isConnected ? openerRef.current : changeRef.current}><DialogHeader><DialogTitle>What are we watching?</DialogTitle><DialogDescription>Paste another magnet or HTTPS .torrent link below. Loading it starts a fresh buffer for everyone.</DialogDescription></DialogHeader>{torrentForm}<p className="help-limit">Use a magnet or HTTPS .torrent link with browser-compatible video and WebRTC seeders or web seeds.</p></DialogContent></Dialog>
    <Dialog open={!!swarm.invitation}><DialogContent className="modal" showCloseButton={false}><DialogHeader><DialogTitle>There’s a seat for you.</DialogTitle><DialogDescription>Pick a name so your friends know you’ve arrived.</DialogDescription></DialogHeader><form onSubmit={event => { event.preventDefault(); if (swarm.busy) return; setModal(null); void swarm.join(guestName).then(() => headingRef.current?.focus()); }}><label htmlFor="guest-name">Your name</label><input className="text-input" id="guest-name" value={guestName} onChange={e => setGuestName(e.target.value)} placeholder="What should we call you?" maxLength={24} required autoComplete="name"/><button className="primary-button" style={{ marginTop: 16 }} aria-busy={swarm.busy} disabled={!guestName.trim()}>{swarm.busy ? <><LoaderCircle className="spin" size={16}/><span className="sr-only">Joining the couch</span></> : <>Join the couch <ArrowRight size={16}/></>}</button></form>{swarm.error && <div role="alert" className="error">{swarm.error}</div>}<button className="quiet-button" onClick={() => location.assign('/')}>Create your own room instead</button></DialogContent></Dialog>
  </div>;
}
