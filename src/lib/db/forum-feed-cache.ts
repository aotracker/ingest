import { eq } from "drizzle-orm";
import {
  ALBION_FORUM_PATCH_NOTES_FEED_KEY,
  type ForumPatchNoteItem,
} from "./schema";
import { db, schema } from "./index";
import { fetchForumPatchNotesRss } from "../feeds/forum-rss";

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export async function refreshForumPatchNotesFeed(): Promise<void> {
  const existing = await db.query.externalFeedCache.findFirst({
    where: eq(
      schema.externalFeedCache.feedKey,
      ALBION_FORUM_PATCH_NOTES_FEED_KEY
    ),
  });

  if (
    existing?.fetchedAt &&
    Date.now() - existing.fetchedAt.getTime() < REFRESH_INTERVAL_MS
  ) {
    return;
  }

  try {
    const items = await fetchForumPatchNotesRss();
    await upsertFeedCache({
      items,
      fetchedAt: new Date(),
      lastError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[patch-notes] forum RSS refresh failed: ${message}`);
    await upsertFeedCache({
      items: existing?.items ?? [],
      fetchedAt: existing?.fetchedAt ?? null,
      lastError: message,
    });
  }
}

async function upsertFeedCache(values: {
  items: ForumPatchNoteItem[];
  fetchedAt: Date | null;
  lastError: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.externalFeedCache)
    .values({
      feedKey: ALBION_FORUM_PATCH_NOTES_FEED_KEY,
      items: values.items,
      fetchedAt: values.fetchedAt,
      lastError: values.lastError,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.externalFeedCache.feedKey,
      set: {
        items: values.items,
        fetchedAt: values.fetchedAt,
        lastError: values.lastError,
        updatedAt: now,
      },
    });
}
