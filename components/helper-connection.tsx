'use client';
import { useEffect, useState } from 'react';
import { Download, Link2, MonitorPlay } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { helperRequest, helperStatus, type HelperStatus } from '@/lib/remote-helper';
import { PAIR_TTL_MS, type Session } from '@/lib/sync';

export function HelperConnection({ session, isHost, reconnectIfOwnHelper, needed, open, onOpenChange }:
  { session: Session; isHost: boolean; reconnectIfOwnHelper: () => void; needed: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [pairingUrl, setPairingUrl] = useState('');
  const [pairingExpires, setPairingExpires] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let running = false;
    async function poll() {
      let paired = false;
      running = true;
      try {
        const result = await helperStatus(session, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(result);
        // Pressing the button while a claim was already in flight answers 409; once the helper reads as connected that complaint is stale.
        if (result.mine && result.online) { setPairingUrl(''); setError(''); }
        paired = result.paired;
      } catch { /* The room connection already reports connectivity failures. */ }
      finally { running = false; }
      // A hidden tab stops polling entirely; the listener below restarts it the moment the user comes back.
      // The fast cadence only buys anything while the dialog is on screen: outside it the status drives a hint nobody is watching.
      // An outstanding link counts too: `paired` stays false until the helper claims it, which is the moment worth reporting quickly.
      if (!abort.signal.aborted && !document.hidden) timer = setTimeout(() => void poll(), open && (paired || pairingUrl) ? 3000 : 15000);
    }
    const onVisibility = () => { clearTimeout(timer); if (!document.hidden && !running) void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    return () => { abort.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [session, open, pairingUrl]);
  // The code behind the link dies on the server's schedule, so take the link away rather than let Copy hand over a dead one.
  useEffect(() => {
    if (!pairingUrl) return;
    const timer = setTimeout(() => { setPairingUrl(''); setCopied(false); }, Math.max(0, pairingExpires - Date.now()));
    return () => clearTimeout(timer);
  }, [pairingUrl, pairingExpires]);
  async function pair() {
    setBusy(true); setError(''); setCopied(false);
    try { const result = await helperRequest<{ pairingUrl: string; expiresIn: number }>(session, { action: 'pair' }); setPairingUrl(result.pairingUrl); setPairingExpires(Date.now() + result.expiresIn * 1000); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not create a pairing link.'); }
    finally { setBusy(false); }
  }
  async function unpair() {
    setBusy(true); setError('');
    // Only the pipeline knows whether it is streaming from this helper right now: a paired row stays behind a
    // helper that was stopped or went offline, so asking the status would restart a stream nothing changed.
    try { await helperRequest(session, { action: 'unpair' }); setPairingUrl(''); setStatus(await helperStatus(session)); reconnectIfOwnHelper(); }
    catch { setError('Could not disconnect the helper. Try again.'); }
    finally { setBusy(false); }
  }
  // The status describes the helper this browser streams from; `mineOnline` reports this participant's own helper, which may not be the one selected.
  const running = !!status?.mineOnline;
  const hostServing = !!status?.paired && !status.own;
  // Everyone gets a next step: the host to start theirs, a guest to stop depending on the host's. Nobody gets
  // one before the first status lands, or while they keep failing: every branch below would be a guess.
  const hint = running || !status ? ''
    : hostServing ? status!.online
      ? 'Streaming through your host’s helper. Run your own to download straight from torrent peers.'
      : 'Waiting for your host’s helper. You can run your own instead.'
    : isHost ? 'Start your helper so this room can reach ordinary torrent peers. Your friends only need the room link.'
    : 'Nobody is running a helper yet. Run your own to reach ordinary torrent peers.';
  return <div className="helper-connection">
    <button className={`helper-button ${needed && !running ? 'primary-button' : 'outline-button'}`} onClick={() => onOpenChange(true)}><MonitorPlay size={16}/>{running ? 'Helper connected' : 'Connect your helper'}</button>
    {hint && <p className="helper-note">{hint}</p>}
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="modal"><DialogHeader><DialogTitle>Your movie-night helper</DialogTitle><DialogDescription>{isHost ? 'Run the helper on your Windows computer and keep it open while you watch. Your friends only need the room link.' : 'Run the helper on your Windows computer to download from torrent peers yourself instead of through your host. Keep it open while you watch.'}</DialogDescription></DialogHeader>
      <ol className="helper-steps"><li>{status?.downloadUrl ? <><a className="outline-button" href={status.downloadUrl}><Download size={16}/> Download for Windows</a><p>Extract the ZIP, then open CouchSwarm Helper.exe. This build isn’t code-signed yet, so Windows SmartScreen says “unknown publisher”: choose More info, then Run anyway. When your first movie loads, Windows may also ask whether “Node.js JavaScript Runtime” — the helper’s bundled runtime — can use your network; allow it on private networks so torrent peers can reach you too.</p></> : <span>The helper download isn’t configured for this site yet. Build it from the CouchSwarm source with npm run build:helper, or ask the site owner for the ZIP.</span>}</li>
        <li>{status?.mineOnline ? <p>Your helper is already connected. Use “Disconnect helper” below before pairing another computer.</p> : <><button className="primary-button" aria-busy={busy} onClick={() => { if (!busy) void pair(); }}>{pairingUrl ? 'Create a fresh pairing link' : 'Create pairing link'}<Link2 size={16}/></button><p>Paste this private link into the helper. It works once and expires in {Math.round(PAIR_TTL_MS / 60000)} minutes.</p></>}</li></ol>
      {pairingUrl && <><div className="invite-link"><input className="text-input" aria-label="Private helper pairing link" readOnly value={pairingUrl} onFocus={event => event.target.select()}/><button className="primary-button" onClick={async () => { try { await navigator.clipboard.writeText(pairingUrl); setCopied(true); } catch { setError('Select the link and copy it manually.'); } }}>{copied ? 'Copied' : 'Copy'}</button></div><output className="sr-only" aria-live="polite" aria-atomic="true">{copied ? 'Pairing link copied' : ''}</output></>}
      <output className="helper-note">{running ? status.mineStatus : 'Waiting for your helper.'}</output>
      {running && !status.relayAvailable && <p className="helper-note">Direct connections are available. The site owner still needs to configure a relay for networks that block them.</p>}
      {status?.mine && <button className="quiet-button" aria-busy={busy} onClick={() => { if (!busy) void unpair(); }}>Disconnect helper</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </DialogContent></Dialog>
  </div>;
}
