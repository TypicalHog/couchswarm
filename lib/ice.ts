export async function iceConfiguration(identity: string) {
  const stun = (process.env.COUCHSWARM_STUN_URLS || '').split(',').map(url => url.trim()).filter(url => url.startsWith('stun:'));
  const iceServers: RTCIceServer[] = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302'] }];
  const urls = (process.env.COUCHSWARM_TURN_URLS || '').split(',').map(url => url.trim()).filter(url => /^turns?:/.test(url));
  const secret = process.env.COUCHSWARM_TURN_SECRET;
  if (urls.length && secret) {
    const username = `${(Math.floor(Date.now() / 3600000) + 25) * 3600}:${identity}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username)));
    iceServers.push({ urls, username, credential: btoa(String.fromCharCode(...bytes)) });
  }
  return { iceServers, relayAvailable: iceServers.length > 1 };
}
