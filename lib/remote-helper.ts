import type { Session } from '@/lib/sync';

export type HelperStatus = { paired: boolean; online: boolean; ready: boolean; own: boolean; mine: boolean; mineOnline: boolean; mineStatus: string; status: string; infoHash: string; downloadUrl: string; iceServers: RTCIceServer[]; relayAvailable: boolean };
export async function helperRequest<T>(session: Session, body: object, signal?: AbortSignal): Promise<T> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  const response = await fetch(`/api/rooms/${session.roomId}/helper`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify(body), signal: bounded });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || 'The helper connection failed.'), { status: response.status });
  return data;
}
export const helperStatus = (session: Session, signal?: AbortSignal) => helperRequest<HelperStatus>(session, { action: 'status' }, signal);

export async function connectRemoteHelper(session: Session, mediaVersion: number, signal: AbortSignal,
  report: (message: string) => void, disconnected: (own: boolean) => void) {
  let status = await helperStatus(session, signal);
  if (!status.paired) return null;
  const sleep = () => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const deadline = Date.now() + 120000, offlineDeadline = Date.now() + 20000;
  let misses = 0;
  while (!status.ready) {
    // Offline for a while: stream browser-only now; the readiness watcher upgrades when the helper returns.
    if (!status.online && Date.now() > offlineDeadline) return null;
    if (Date.now() > deadline) throw new Error(`${status.own ? 'Your' : 'The host’s'} helper is not ready. Keep it open and check that the torrent has seeders.`);
    report(status.online ? status.status : status.own ? 'Open your helper to continue…' : 'Waiting for the host to open their helper…');
    await sleep();
    // A blip in a 120 s wait is not a dead helper; the heartbeat below tolerates the same four misses.
    try { status = await helperStatus(session, signal); misses = 0; }
    catch (error) {
      const code = (error as { status?: number }).status;
      if (signal.aborted || code === 403 || code === 410 || ++misses >= 4) throw error;
      continue;
    }
    if (!status.paired) return null;
  }
  const { own } = status;
  const label = own ? 'your helper' : 'the host’s helper';
  report(`Connecting to ${label}…`);
  const { default: SimplePeer } = await import('@thaunknown/simple-peer');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const peer = new SimplePeer({ initiator: true, trickle: false, config: { iceServers: status.iceServers } });
  peer.id = crypto.randomUUID();
  let peerId = '', released = false, timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true; clearTimeout(timer); peer.destroy();
    signal.removeEventListener('abort', release);
    if (peerId) void helperRequest(session, { action: 'close', peerId }).catch(() => {});
  };
  signal.addEventListener('abort', release, { once: true });
  peer.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(status.relayAvailable
        ? `Could not connect to ${label}. Reconnect to try again.`
        : 'A connection relay is not configured. These networks could not connect directly.')), 45000);
      peer.once('connect', () => { clearTimeout(timeout); resolve(); });
      peer.once('close', () => { clearTimeout(timeout); reject(new Error('The helper connection closed.')); });
      peer.once('disconnect', () => { clearTimeout(timeout); reject(new Error('The helper disconnected.')); });
      peer.once('error', error => { clearTimeout(timeout); reject(error); });
      peer.once('signal', async offer => {
        try {
          const result = await helperRequest<{ peerId: string }>(session, { action: 'offer', mediaVersion, offer }, signal);
          peerId = result.peerId;
          if (released) { void helperRequest(session, { action: 'close', peerId }).catch(() => {}); return; }
          while (!released) {
            const result = await helperRequest<{ answer: unknown }>(session, { action: 'peer', peerId }, signal);
            if (result.answer) { peer.signal(result.answer); break; }
            await sleep();
          }
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
    });
    let misses = 0;
    const heartbeat = async () => {
      if (released) return;
      try { await helperRequest(session, { action: 'peer', peerId }, signal); misses = 0; }
      catch (error) {
        if (signal.aborted || released) return;
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 410 || ++misses >= 4) { disconnected(own); release(); return; }
      }
      if (!released) timer = setTimeout(() => void heartbeat(), 5000);
    };
    timer = setTimeout(() => void heartbeat(), 5000);
    const onDisconnect = () => { if (!released && !signal.aborted) disconnected(own); release(); };
    peer.once('close', onDisconnect); peer.once('disconnect', onDisconnect);
    return { infoHash: status.infoHash, peer, release, own };
  } catch (error) { release(); throw error; }
}
