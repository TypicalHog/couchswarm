import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostId: text('host_id').notNull(),
  inviteHash: text('invite_hash').notNull(),
  hostKeyHash: text('host_key_hash').notNull().default(''),
  source: text('source').notNull().default(''),
  fileIndex: integer('file_index').notNull().default(0),
  mediaVersion: integer('media_version').notNull().default(0),
  epoch: integer('epoch').notNull().default(0),
  revision: integer('revision').notNull().default(0),
  playing: integer('playing').notNull().default(0),
  position: real('position').notNull().default(0),
  startsAt: integer('starts_at').notNull().default(0),
  duration: real('duration').notNull().default(0),
  reason: text('reason').notNull().default('Waiting for a movie.'),
  createdAt: integer('created_at').notNull(),
}, table => [index('idx_rooms_created').on(table.createdAt)]);

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id),
  tokenHash: text('token_hash').notNull(),
  name: text('name').notNull(),
  ready: integer('ready').notNull().default(0),
  buffered: real('buffered').notNull().default(0),
  progress: real('progress').notNull().default(0),
  epoch: integer('epoch').notNull().default(-1),
  lastSeen: integer('last_seen').notNull(),
  reportSequence: integer('report_sequence').notNull().default(0),
  joinedAt: integer('joined_at').notNull().default(0),
}, table => [index('idx_members_room_presence').on(table.roomId, table.lastSeen), index('idx_members_room_joined').on(table.roomId, table.joinedAt), uniqueIndex('idx_members_token').on(table.tokenHash)]);

export const helpers = sqliteTable('helpers', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id),
  memberId: text('member_id').notNull().default(''),
  pairHash: text('pair_hash').notNull(),
  pairExpires: integer('pair_expires').notNull(),
  tokenHash: text('token_hash'),
  lastSeen: integer('last_seen').notNull().default(0),
  status: text('status').notNull().default('Waiting for the helper.'),
  mediaVersion: integer('media_version').notNull().default(-1),
  infoHash: text('info_hash').notNull().default(''),
}, table => [uniqueIndex('idx_helpers_member').on(table.roomId, table.memberId), uniqueIndex('idx_helpers_pair').on(table.pairHash)]);

export const helperPeers = sqliteTable('helper_peers', {
  id: text('id').primaryKey(),
  helperId: text('helper_id').notNull().references(() => helpers.id),
  memberId: text('member_id').notNull().references(() => members.id),
  mediaVersion: integer('media_version').notNull(),
  offer: text('offer').notNull(),
  answer: text('answer'),
  lastSeen: integer('last_seen').notNull(),
}, table => [index('idx_helper_peers_helper').on(table.helperId), uniqueIndex('idx_helper_peers_member').on(table.memberId)]);
