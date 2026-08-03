CREATE TABLE `__new_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_chat_id` text,
	`source_message_ids` text,
	`kind` text DEFAULT 'single' NOT NULL,
	`content_type` text DEFAULT 'text' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`channel_id` text,
	`channel_message_ids` text,
	`mode` text,
	`posted_at` integer
);
--> statement-breakpoint
-- Already published, oldest first: these rows never kept the source message,
-- so it stays null, and `posted_at` is the best `created_at` we have.
INSERT INTO `__new_posts` (
	`source_chat_id`, `source_message_ids`, `kind`, `content_type`, `preview`, `created_at`,
	`channel_id`, `channel_message_ids`, `mode`, `posted_at`
)
SELECT NULL, NULL, 'single', `content_type`, `preview`, `posted_at`,
	`channel_id`, `message_ids`, `mode`, `posted_at`
FROM `posts` ORDER BY `posted_at`;
--> statement-breakpoint
-- Still queued: inserted after the history so the new ids keep FIFO order.
INSERT INTO `__new_posts` (
	`source_chat_id`, `source_message_ids`, `kind`, `content_type`, `preview`, `created_at`,
	`channel_id`, `channel_message_ids`, `mode`, `posted_at`
)
SELECT `source_chat_id`, `message_ids`, `kind`, `content_type`, `preview`, `created_at`,
	NULL, NULL, NULL, NULL
FROM `queue_items` ORDER BY `id`;
--> statement-breakpoint
DROP TABLE `posts`;
--> statement-breakpoint
DROP TABLE `queue_items`;
--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;
