// Mirrors MAX_SEATS, MAX_HELPER_PEERS and PRESENCE_MS in lib/sync.ts; a .mjs helper or suite cannot import the .ts
// module. Keep them equal; tests/sync.test.ts fails by name when they drift.
export const MAX_SEATS = 12;
export const MAX_HELPER_PEERS = 12;
export const PRESENCE_MS = 12_000;
export const MAX_ROOM_TORRENTS = 2;
