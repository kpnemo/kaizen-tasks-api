import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { users, type UserRow } from "../db/schema.js";

export async function insertUser(
  db: DbOrTx,
  values: { email: string; passwordHash: string; displayName: string },
): Promise<UserRow> {
  const [row] = await db.insert(users).values(values).returning();
  if (!row) throw new Error("insert users returned no row");
  return row;
}

export async function findUserByEmail(db: DbOrTx, email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row;
}

export async function findUserById(db: DbOrTx, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function updateUserTheme(
  db: DbOrTx,
  id: string,
  theme: UserRow["theme"],
): Promise<UserRow | undefined> {
  const [row] = await db
    .update(users)
    .set({ theme, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return row;
}
