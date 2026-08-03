CREATE TABLE `channels` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`username` text,
	`type` text DEFAULT 'channel' NOT NULL,
	`status` text DEFAULT 'member' NOT NULL,
	`can_post` integer DEFAULT false NOT NULL,
	`last_post_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`message_ids` text NOT NULL,
	`content_type` text DEFAULT 'text' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`posted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `queue_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_chat_id` text NOT NULL,
	`message_ids` text NOT NULL,
	`kind` text DEFAULT 'single' NOT NULL,
	`content_type` text DEFAULT 'text' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`bot_token` text,
	`admin_id` text,
	`target_channel_id` text,
	`delay_minutes` integer DEFAULT 60 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`updated_at` integer NOT NULL
);
