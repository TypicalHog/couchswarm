export const BUFFER_SECONDS = 8;
export const PRESENCE_MS = 12_000;
export const ROOM_TTL_MS = 86_400_000;
// How long a room past its day must go unheard-from before it is swept away. Far more than the presence lease:
// a provider blip or the backoff that follows one leaves every member silent for a while, and a room with people
// still on the couch must not be deleted out from under them for that.
export const EXPIRY_GRACE_MS = 600_000;
export const MAX_SEATS = 12;
export const HELPER_ONLINE_MS = 15_000;
export const HELPER_PEER_TTL_MS = 60_000;
export const MAX_HELPER_PEERS = 12;
export const PAIR_TTL_MS = 300_000;
export const SPECTATOR_EPOCH = -2;
export type Room = {
  id: string; hostId: string; source: string; fileIndex: number;
  mediaVersion: number; epoch: number; revision: number; playing: boolean;
  position: number; startsAt: number; duration: number; reason: string;
  // A tag of the invite's hash, never the invite itself: a tab can tell the link it is showing has been rotated
  // away without the room ever handing the new one out. Optional, so a reply without it just leaves the link up.
  inviteTag?: string;
};
export type Member = {
  // ready folds in everything that has to be true before a member can watch, so a seat that never unlocked
  // playback is indistinguishable from one still filling its buffer. armed reports that half on its own, which
  // is the half the host can do nothing about but ask.
  id: string; name: string; ready: boolean; armed: boolean; buffered: number;
  epoch: number; lastSeen: number;
};
export type Snapshot = { room: Room; members: Member[]; serverNow: number; serverReceivedAt: number };
export type Session = { roomId: string; memberId: string; token: string; invite: string; hostKey?: string };

export function estimateServerNow(serverNow: number, serverReceivedAt: number, roundTripMs: number) {
  return serverNow + Math.max(0, roundTripMs - (serverNow - serverReceivedAt)) / 2;
}

export function timelinePosition(room: Pick<Room, 'position' | 'playing' | 'startsAt' | 'duration'>, now: number) {
  const position = room.position + (room.playing ? Math.max(0, now - room.startsAt) / 1000 : 0);
  return Math.max(0, room.duration > 0 ? Math.min(room.duration, position) : position);
}

// Segment joins can leave seams a few frames wide; hls.js plays across up to 0.1s, so a range starting within
// a seam of the playhead counts, and so does the range on the far side of one (0.1001 because an exactly-0.1s
// seam subtracts to either side of 0.1 in binary floating point).
const SEAM = 0.1001;

export function bufferedAhead(ranges: Pick<TimeRanges, 'length' | 'start' | 'end'>, position: number) {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) - position >= SEAM || ranges.end(i) <= position) continue;
    let end = ranges.end(i);
    while (i + 1 < ranges.length && ranges.start(i + 1) - end < SEAM) end = ranges.end(++i);
    return end - position;
  }
  return 0;
}

export function hasBuffer(buffered: number, position: number, duration: number, playing: boolean) {
  if (!(duration > 0)) return false;
  return buffered >= Math.min(playing ? 3 : BUFFER_SECONDS, Math.max(0, duration - position - 0.2));
}

export function validSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /\p{Cc}/u.test(value)) return false;
  if (value.startsWith('magnet:?')) {
    const hashes = new URLSearchParams(value.slice(8)).getAll('xt');
    return hashes.some(hash => /^urn:btih:([a-f\d]{40}|[a-z2-7]{32})$/i.test(hash));
  }
  try { const url = new URL(value); return url.protocol === 'https:' && /\.torrent$/i.test(url.pathname) && !url.username && !url.password; }
  catch { return false; }
}

export function allReady(members: Member[], room: Room, now: number) {
  const active = members.filter(m => m.lastSeen > now - PRESENCE_MS);
  return active.some(m => m.id === room.hostId) && active.every(m => m.epoch === SPECTATOR_EPOCH || (m.ready && m.epoch === room.epoch));
}
