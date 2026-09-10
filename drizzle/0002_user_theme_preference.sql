CREATE TYPE "public"."theme_preference" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" "theme_preference" DEFAULT 'system' NOT NULL;