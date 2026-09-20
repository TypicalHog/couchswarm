ALTER TABLE `members` ADD `joined_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_members_room_joined` ON `members` (`room_id`,`joined_at`);