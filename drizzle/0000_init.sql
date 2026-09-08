CREATE TYPE "public"."ai_skip_reason" AS ENUM('too_short', 'rate_limited', 'ai_disabled');--> statement-breakpoint
CREATE TYPE "public"."ai_status" AS ENUM('pending', 'running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."suggestion_state" AS ENUM('suggested', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."task_origin" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_tags" (
	"task_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "task_tags_task_id_tag_id_pk" PRIMARY KEY("task_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"origin" "task_origin" DEFAULT 'user' NOT NULL,
	"suggestion_state" "suggestion_state",
	"rationale" text,
	"ai_status" "ai_status" DEFAULT 'pending' NOT NULL,
	"ai_skip_reason" "ai_skip_reason",
	"ai_error" text,
	"generation_id" uuid,
	"ai_tag_suggestions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_suggestion_state_origin_check" CHECK (("tasks"."origin" = 'ai') = ("tasks"."suggestion_state" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_lower_name_idx" ON "tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "tasks_user_created_idx" ON "tasks" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_parent_position_idx" ON "tasks" USING btree ("parent_id","position","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_ai_status_updated_idx" ON "tasks" USING btree ("ai_status","updated_at");