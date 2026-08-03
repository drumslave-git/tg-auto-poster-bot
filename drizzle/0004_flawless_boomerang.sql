ALTER TABLE `posts` ADD `source_text` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `source_entities` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `post_footer` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `window_start_minutes` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `window_end_minutes` integer;