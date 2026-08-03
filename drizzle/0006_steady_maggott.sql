ALTER TABLE `settings` ADD `watermark_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `watermark_x` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `watermark_y` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `watermark_opacity` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `watermark_scale` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `watermark_required` integer DEFAULT false NOT NULL;