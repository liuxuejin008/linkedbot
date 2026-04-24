import type { ChannelRole, ChannelRow } from "../types";

const ROLE_RANK: Record<ChannelRole, number> = { owner: 3, member: 2, readonly: 1 };

export async function getChannelRole(
  db: D1Database,
  channelId: number,
  userId: number
): Promise<ChannelRole | null> {
  const ch = await db
    .prepare("SELECT owner_user_id FROM channels WHERE id = ?")
    .bind(channelId)
    .first<Pick<ChannelRow, "owner_user_id">>();

  if (!ch) return null;
  if (ch.owner_user_id === userId) return "owner";

  const member = await db
    .prepare("SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .bind(channelId, userId)
    .first<{ role: ChannelRole }>();

  return member?.role ?? null;
}

export async function checkChannelAccess(
  db: D1Database,
  channelId: number,
  userId: number,
  minRole: ChannelRole = "readonly"
): Promise<ChannelRow | null> {
  const ch = await db
    .prepare("SELECT * FROM channels WHERE id = ?")
    .bind(channelId)
    .first<ChannelRow>();

  if (!ch) return null;

  let role: ChannelRole | null;
  if (ch.owner_user_id === userId) {
    role = "owner";
  } else {
    const member = await db
      .prepare("SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .bind(channelId, userId)
      .first<{ role: ChannelRole }>();
    role = member?.role ?? null;
  }

  if (!role) return null;
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) return null;

  return ch;
}
