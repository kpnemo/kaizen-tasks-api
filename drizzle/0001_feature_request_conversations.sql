CREATE TYPE "public"."feature_request_conversation_status" AS ENUM('open', 'ready', 'filed', 'abandoned');--> statement-breakpoint
CREATE TABLE "feature_request_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "feature_request_conversation_status" DEFAULT 'open' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" jsonb,
	"question_count" integer DEFAULT 0 NOT NULL,
	"still_missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_number" integer,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_request_conversations" ADD CONSTRAINT "feature_request_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_request_conversations_open_user_idx" ON "feature_request_conversations" USING btree ("user_id") WHERE "feature_request_conversations"."status" in ('open', 'ready');