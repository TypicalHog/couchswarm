import type { Session } from './sync';

type HelperStatus = { ready: boolean; error: string; peers: number; speed: number; downloaded: number };

// A browser without AbortSignal.any never gets a room session, so this path needs no fallback for one.
const anySignal = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

export async function connectHelper(session: Session, source: string, mediaVersion: number,
  signal: AbortSignal, update: (status: HelperStatus) => void) {
  const base = '/torrent-helper';
  // Hosted sites without a helper retain ordinary browser WebTorrent support.
  let health: { available?: boolean };
  try {
    const response = await fetch(`${base}/health`, { signal: anySignal(signal, 2000) });
    if (!response.ok) return null;
    health = await response.json() as { available?: boolean };
  } catch { signal.throwIfAborted(); return null; }
  if (health.available !== true) return null;
  const response = await fetch(`${base}/sessions`, { method: 'POST', signal,
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: session.roomId }) });
  const lease = await response.json().catch(() => ({})) as { id: string; source: string; mediaVersion: number; error?: string };
  if (!response.ok) throw Object.assign(new Error(lease.error || 'The torrent helper could not connect.'), { status: response.status });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    void fetch(`${base}/sessions/${lease.id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  signal.addEventListener('abort', release, { once: true });
  if (signal.aborted) { release(); signal.throwIfAborted(); }
  try {
    if (lease.source !== source || lease.mediaVersion !== mediaVersion) throw new Error('The room changed while the helper was connecting.');
    async function status() {
      const response = await fetch(`${base}/sessions/${lease.id}`, { signal: anySignal(signal, 10000) });
      const value = await response.json().catch(() => ({})) as HelperStatus;
      if (!response.ok || value.error) throw Object.assign(new Error(value.error || 'The helper disconnected. Reconnect to the movie.'), { status: response.status });
      update(value);
      return value;
    }
    while (!(await status()).ready) {
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1000);
        signal.addEventListener('abort', stop, { once: true });
      });
    }
    const metadataResponse = await fetch(`${base}/metadata/${lease.id}`, { signal });
    if (!metadataResponse.ok) throw new Error('The helper could not deliver torrent metadata.');
    return { metadata: new Uint8Array(await metadataResponse.arrayBuffer()),
      seedUrl: new URL(`${base}/seed/${lease.id}`, location.origin).href, status, release };
  } catch (error) {
    signal.removeEventListener('abort', release); release(); throw error;
  }
}
