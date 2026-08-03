CREATE TABLE `users` (
	`telegram_id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'manager' NOT NULL,
	`label` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `users` (`telegram_id`, `role`, `created_at`)
SELECT trim(`admin_id`), 'admin', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `settings`
WHERE `admin_id` IS NOT NULL AND trim(`admin_id`) <> '';--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `admin_id`;