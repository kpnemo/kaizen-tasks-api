import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { hashPassword } from "../lib/auth.js";
import { createDb, type Db, type DbOrTx } from "./client.js";
import { tags, tasks, taskTags, users } from "./schema.js";

export const DEMO_EMAIL = "demo@kaizen.local";

/** Stable, valid v4-shaped UUIDs so the runbook and the smoke test can refer to fixtures by id. */
const stableId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SEED_IDS = {
  demoUser: stableId(1),
  tags: {
    work: stableId(301),
    personal: stableId(302),
    urgent: stableId(303),
    writing: stableId(304),
  },
  tasks: {
    offsite: stableId(101),
    onboarding: stableId(102),
    flakyTest: stableId(103),
    lease: stableId(104),
    interviews: stableId(105),
  },
  children: {
    offsite1: stableId(201),
    offsite2: stableId(202),
    offsite3: stableId(203),
    offsite4: stableId(204),
    onboarding1: stableId(211),
    onboarding2: stableId(212),
    onboarding3: stableId(213),
    interviews1: stableId(221),
    interviews2: stableId(222),
    interviews3: stableId(223),
  },
  generations: {
    offsite: stableId(901),
    onboarding: stableId(902),
    flakyTest: stableId(903),
    lease: stableId(904),
    interviews: stableId(905),
  },
} as const;

export interface SeedResult {
  demoUserId: string;
  created: boolean;
}

const UNAVAILABLE_MESSAGE = "The assistant is unavailable, try again";

async function insertFixtures(tx: DbOrTx, passwordHash: string): Promise<void> {
  const u = SEED_IDS.demoUser;
  const T = SEED_IDS.tags;
  const K = SEED_IDS.tasks;
  const C = SEED_IDS.children;
  const G = SEED_IDS.generations;

  await tx
    .insert(users)
    .values({ id: u, email: DEMO_EMAIL, passwordHash, displayName: "Demo User" });

  await tx.insert(tags).values([
    { id: T.work, userId: u, name: "work", color: "#2563eb" },
    { id: T.personal, userId: u, name: "personal", color: "#16a34a" },
    { id: T.urgent, userId: u, name: "urgent", color: "#dc2626" },
    { id: T.writing, userId: u, name: "writing", color: "#9333ea" },
  ]);

  await tx.insert(tasks).values([
    {
      id: K.offsite,
      userId: u,
      title: "Plan the Q4 team offsite",
      description: "Two days, twelve people, somewhere within two hours of the office.",
      status: "in_progress",
      position: 0,
      aiStatus: "done",
      generationId: G.offsite,
    },
    {
      id: K.onboarding,
      userId: u,
      title: "Write the onboarding guide for new PMs",
      description: "What a new PM needs in the first two weeks.",
      status: "todo",
      position: 1,
      aiStatus: "done",
      generationId: G.onboarding,
      aiTagSuggestions: ["documentation"],
    },
    {
      id: K.flakyTest,
      userId: u,
      title: "Fix the flaky login test in CI",
      description: "Fails about one run in five on the login redirect assertion.",
      status: "todo",
      position: 2,
      aiStatus: "failed",
      aiError: UNAVAILABLE_MESSAGE,
      generationId: G.flakyTest,
    },
    {
      id: K.lease,
      userId: u,
      title: "Renew lease",
      status: "done",
      position: 3,
      aiStatus: "skipped",
      aiSkipReason: "too_short",
      generationId: G.lease,
    },
    {
      id: K.interviews,
      userId: u,
      title: "Prepare the customer interview script for the pilot",
      description: "Five interviews next week with contact-center supervisors.",
      status: "todo",
      position: 4,
      aiStatus: "done",
      generationId: G.interviews,
      aiTagSuggestions: ["research"],
    },
  ]);

  const ai = (state: "suggested" | "accepted" | "dismissed") => ({
    origin: "ai" as const,
    suggestionState: state,
    aiStatus: "skipped" as const,
  });

  await tx.insert(tasks).values([
    // Offsite: accepted AI steps with rationales, two already done.
    {
      id: C.offsite1,
      userId: u,
      parentId: K.offsite,
      position: 0,
      status: "done",
      title: "Write the offsite goal in one sentence",
      rationale: "Every other choice follows from what the offsite must achieve",
      ...ai("accepted"),
    },
    {
      id: C.offsite2,
      userId: u,
      parentId: K.offsite,
      position: 1,
      status: "done",
      title: "Confirm the dates with all twelve attendees",
      rationale: "Headcount and dates constrain the venue search, so they come first",
      ...ai("accepted"),
    },
    {
      id: C.offsite3,
      userId: u,
      parentId: K.offsite,
      position: 2,
      status: "in_progress",
      title: "Shortlist three venues within budget",
      rationale: "A short list makes the booking decision quick once dates are fixed",
      ...ai("accepted"),
    },
    {
      id: C.offsite4,
      userId: u,
      parentId: K.offsite,
      position: 3,
      status: "todo",
      title: "Book the venue and send invites",
      rationale: "Booking locks the plan so agenda work can start",
      ...ai("accepted"),
    },
    // Onboarding: suggestions still pending review.
    {
      id: C.onboarding1,
      userId: u,
      parentId: K.onboarding,
      position: 0,
      title: "List the ten questions every new PM asks in week one",
      rationale: "The guide answers real questions, so collecting them comes first",
      ...ai("suggested"),
    },
    {
      id: C.onboarding2,
      userId: u,
      parentId: K.onboarding,
      position: 1,
      title: "Draft the first-week checklist",
      rationale: "A checklist is the smallest useful version of the guide",
      ...ai("suggested"),
    },
    {
      id: C.onboarding3,
      userId: u,
      parentId: K.onboarding,
      position: 2,
      title: "Ask two recent hires to review the draft",
      rationale: "Recent hires remember what was missing",
      ...ai("suggested"),
    },
    // Interviews: a user step, an accepted AI step, a dismissed AI step.
    {
      id: C.interviews1,
      userId: u,
      parentId: K.interviews,
      position: 0,
      status: "done",
      title: "Write the three questions the pilot must answer",
      origin: "user",
      aiStatus: "skipped",
    },
    {
      id: C.interviews2,
      userId: u,
      parentId: K.interviews,
      position: 1,
      title: "Draft the interview script around those questions",
      rationale: "The script follows from the questions it must answer",
      ...ai("accepted"),
    },
    {
      id: C.interviews3,
      userId: u,
      parentId: K.interviews,
      position: 2,
      title: "Schedule a dry run with a colleague",
      rationale: "A rehearsal catches awkward questions before the real interviews",
      ...ai("dismissed"),
    },
  ]);

  await tx.insert(taskTags).values([
    { taskId: K.offsite, tagId: T.work },
    { taskId: K.onboarding, tagId: T.work },
    { taskId: K.onboarding, tagId: T.writing },
    { taskId: K.flakyTest, tagId: T.urgent },
    { taskId: K.lease, tagId: T.personal },
    { taskId: K.interviews, tagId: T.work },
  ]);
}

/** Startup entry point: creates the fixtures only if the demo user is absent. */
export async function ensureDemoSeed(db: Db, password: string): Promise<SeedResult> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1);
  if (existing) return { demoUserId: existing.id, created: false };
  const passwordHash = await hashPassword(password);
  await db.transaction((tx) => insertFixtures(tx, passwordHash));
  return { demoUserId: SEED_IDS.demoUser, created: true };
}

/** Facilitator entry point: deletes the demo user (cascading everything) and recreates the fixtures, in one transaction. */
export async function resetDemoSeed(db: Db, password: string): Promise<SeedResult> {
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.delete(users).where(eq(users.email, DEMO_EMAIL));
    await insertFixtures(tx, passwordHash);
  });
  return { demoUserId: SEED_IDS.demoUser, created: true };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: 1 });
  const reset = process.argv.includes("--reset");
  const result = reset
    ? await resetDemoSeed(db, config.SEED_DEMO_PASSWORD)
    : await ensureDemoSeed(db, config.SEED_DEMO_PASSWORD);
  await sql.end();
  console.log(
    `${reset ? "reset" : result.created ? "created" : "already present"}: ${DEMO_EMAIL} (${result.demoUserId})`,
  );
}
