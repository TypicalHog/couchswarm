CREATE TABLE `helper_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`helper_id` text NOT NULL,
	`member_id` text NOT NULL,
	`media_version` integer NOT NULL,
	`offer` text NOT NULL,
	`answer` text,
	`last_seen` integer NOT NULL,
	FOREIGN KEY (`helper_id`) REFERENCES `helpers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_helper_peers_helper` ON `helper_peers` (`helper_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_helper_peers_member` ON `helper_peers` (`member_id`);--> statement-breakpoint
CREATE TABLE `helpers` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text DEFAULT '' NOT NULL,
	`pair_hash` text NOT NULL,
	`pair_expires` integer NOT NULL,
	`token_hash` text,
	`last_seen` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'Waiting for the helper.' NOT NULL,
	`media_version` integer DEFAULT -1 NOT NULL,
	`info_hash` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_helpers_member` ON `helpers` (`room_id`,`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_helpers_pair` ON `helpers` (`pair_hash`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`buffered` real DEFAULT 0 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`epoch` integer DEFAULT -1 NOT NULL,
	`last_seen` integer NOT NULL,
	`report_sequence` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_members_room_presence` ON `members` (`room_id`,`last_seen`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_members_token` ON `members` (`token_hash`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host_id` text NOT NULL,
	`invite_hash` text NOT NULL,
	`host_key_hash` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`file_index` integer DEFAULT 0 NOT NULL,
	`media_version` integer DEFAULT 0 NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`playing` integer DEFAULT 0 NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`starts_at` integer DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`reason` text DEFAULT 'Waiting for a movie.' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rooms_created` ON `rooms` (`created_at`);