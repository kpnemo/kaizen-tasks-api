import { and, eq, inArray } from "drizzle-orm";
import { isUniqueViolation, type Db, type DbOrTx } from "../db/client.js";
import { featureRequestConversations, type FeatureRequestConversationRow } from "../db/schema.js";
import type {
  ConversationMessage,
  ConversationStatus,
  FeatureRequestDraft,
  RubricScore,
} from "../schemas/feature-request-conversations.js";

/** The statuses the partial unique index covers: at most one such row exists per user. */
const LIVE_STATUSES = ["open", "ready"] as const;

export async function findLiveConversation(
  db: DbOrTx,
  userId: string,
): Promise<FeatureRequestConversationRow | undefined> {
  const [row] = await db
    .select()
    .from(featureRequestConversations)
    .where(
      and(
        eq(featureRequestConversations.userId, userId),
        inArray(featureRequestConversations.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(1);
  return row;
}

export async function findOwnedConversation(
  db: DbOrTx,
  id: string,
  userId: string,
): Promise<FeatureRequestConversationRow | undefined> {
  const [row] = await db
    .select()
    .from(featureRequestConversations)
    .where(
      and(eq(featureRequestConversations.id, id), eq(featureRequestConversations.userId, userId)),
    )
    .limit(1);
  return row;
}

export async function insertConversation(
  db: DbOrTx,
  values: { userId: string; messages: ConversationMessage[] },
): Promise<FeatureRequestConversationRow> {
  const [row] = await db.insert(featureRequestConversations).values(values).returning();
  if (!row) throw new Error("insert feature_request_conversations returned no row");
  return row;
}

/** Moves every live conversation of this user to `abandoned`. Returns how many moved. */
export async function abandonLiveConversations(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db
    .update(featureRequestConversations)
    .set({ status: "abandoned", updatedAt: new Date() })
    .where(
      and(
        eq(featureRequestConversations.userId, userId),
        inArray(featureRequestConversations.status, [...LIVE_STATUSES]),
      ),
    )
    .returning({ id: featureRequestConversations.id });
  return rows.length;
}

/**
 * Abandon-then-insert in one transaction, so "start over" can never leave two live conversations
 * or lose the old one without creating the new one. A concurrent second create collides on the
 * partial unique index; `23505` rolls the whole transaction back and comes back as `undefined`,
 * which leaves the prior conversation exactly as it was.
 */
export async function replaceLiveConversation(
  db: Db,
  values: { userId: string; messages: ConversationMessage[] },
): Promise<FeatureRequestConversationRow | undefined> {
  try {
    return await db.transaction(async (tx) => {
      await abandonLiveConversations(tx, values.userId);
      return insertConversation(tx, values);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return undefined;
    throw err;
  }
}

/**
 * The whole turn in one conditional write: transcript, draft, score, counters and status together,
 * guarded by the version the caller read before it called the model. Zero rows matched means the
 * conversation moved on (another turn, or a filing) and this turn must not be persisted.
 */
export async function updateConversationTurn(
  db: DbOrTx,
  key: { id: string; userId: string; expectedVersion: number },
  values: {
    messages: ConversationMessage[];
    draft: FeatureRequestDraft;
    score: RubricScore;
    questionCount: number;
    stillMissing: string[];
    status: ConversationStatus;
  },
): Promise<FeatureRequestConversationRow | undefined> {
  const [row] = await db
    .update(featureRequestConversations)
    .set({ ...values, version: key.expectedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(featureRequestConversations.id, key.id),
        eq(featureRequestConversations.userId, key.userId),
        eq(featureRequestConversations.status, "open"),
        eq(featureRequestConversations.version, key.expectedVersion),
      ),
    )
    .returning();
  return row;
}

/**
 * Conditional on a live status only, not on `version`: filing deliberately wins a race against an
 * in-flight turn, and that turn's own conditional update is the one that then matches nothing.
 */
export async function markConversationFiled(
  db: DbOrTx,
  id: string,
  userId: string,
  issueNumber: number,
): Promise<FeatureRequestConversationRow | undefined> {
  const [row] = await db
    .update(featureRequestConversations)
    .set({ status: "filed", issueNumber, updatedAt: new Date() })
    .where(
      and(
        eq(featureRequestConversations.id, id),
        eq(featureRequestConversations.userId, userId),
        inArray(featureRequestConversations.status, [...LIVE_STATUSES]),
      ),
    )
    .returning();
  return row;
}

/** Exported for the service's ownership check so the status list lives in one place. */
export const isLiveStatus = (status: ConversationStatus): boolean =>
  (LIVE_STATUSES as readonly string[]).includes(status);
