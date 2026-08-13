import type { ForumPatchNoteItem } from "../db/schema";
import { fetchJson, fetchUrlWithCurl } from "./curl-fetch";
import {
  PATCH_NOTES_CHANGELOG_URL,
  excerptFromHtml,
  fetchForumPatchNotesRss,
  parsePubDate,
} from "./forum-rss";

const WIKI_API = "https://wiki.albiononline.com/api.php";

export async function fetchAlbionPatchNotes(): Promise<ForumPatchNoteItem[]> {
  const errors: string[] = [];

  try {
    const items = await fetchForumPatchNotesRss();
    console.log(`[patch-notes] loaded ${items.length} items from forum RSS`);
    return items;
  } catch (err) {
    errors.push(`forum RSS: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const items = await fetchOfficialChangelog();
    console.log(
      `[patch-notes] loaded ${items.length} items from official changelog`
    );
    return items;
  } catch (err) {
    errors.push(
      `official changelog: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    const items = await fetchWikiPatchNotes();
    console.log(`[patch-notes] loaded ${items.length} items from wiki`);
    return items;
  } catch (err) {
    errors.push(`wiki: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new Error(`All patch note sources failed (${errors.join("; ")})`);
}

export function parseOfficialChangelog(html: string): ForumPatchNoteItem[] {
  const items: ForumPatchNoteItem[] = [];
  const itemRe =
    /<a href="(\/changelog\/[^"]+)" class="sidebar-link">[\s\S]*?<span class="sidebar-text[^"]*">([\s\S]*?)<\/span>/gi;
  let match: RegExpExecArray | null;
  const ogDescription = html.match(
    /<meta\s+property="og:description"\s+content="([^"]*)"/i
  )?.[1];

  while ((match = itemRe.exec(html)) !== null) {
    const path = match[1];
    const label = excerptFromHtml(match[2] ?? "");
    const [namePart, datePart] = label.split("|").map((part) => part.trim());
    if (!path || !namePart) continue;
    const publishedAt = parsePubDate(datePart ?? "") ?? new Date().toISOString();
    const url = `https://albiononline.com${path}`;
    items.push({
      title: titleCase(namePart),
      url,
      publishedAt,
      excerpt: items.length === 0 ? excerptFromHtml(ogDescription ?? "") : "",
    });
  }

  return items;
}

async function fetchOfficialChangelog(): Promise<ForumPatchNoteItem[]> {
  const html = await fetchUrlWithCurl(PATCH_NOTES_CHANGELOG_URL, {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    referer: "https://albiononline.com/",
  });
  const items = parseOfficialChangelog(html);
  if (items.length === 0) {
    throw new Error("Official changelog page contained no patch notes");
  }
  return items;
}

interface WikiQueryResponse {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        revisions?: Array<{
          timestamp?: string;
          slots?: { main?: { "*": string } };
        }>;
      }
    >;
  };
}

async function fetchWikiPatchNotes(): Promise<ForumPatchNoteItem[]> {
  const url =
    `${WIKI_API}?action=query&generator=categorymembers` +
    `&gcmtitle=${encodeURIComponent("Category:Patch_notes")}` +
    `&gcmlimit=20&gcmsort=timestamp&gcmdir=desc` +
    `&prop=revisions&rvprop=content|timestamp&rvslots=main&format=json`;
  const data = (await fetchJson(url)) as WikiQueryResponse;
  const pages = Object.values(data.query?.pages ?? {});
  const items: ForumPatchNoteItem[] = [];

  for (const page of pages) {
    const wikitext = page.revisions?.[0]?.slots?.main?.["*"] ?? "";
    const revTs = page.revisions?.[0]?.timestamp;
    const parsed = parseWikiPatchPage(page.title ?? "Patch notes", wikitext, revTs);
    if (parsed) items.push(parsed);
  }

  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (items.length === 0) {
    throw new Error("Wiki Category:Patch_notes returned no parseable pages");
  }
  return items;
}

export function parseWikiPatchPage(
  fallbackTitle: string,
  wikitext: string,
  revisionTimestamp?: string
): ForumPatchNoteItem | null {
  const name = wikiField(wikitext, "name") ?? fallbackTitle;
  const version = wikiField(wikitext, "version");
  const link = wikiField(wikitext, "link");
  const dateRaw = wikiField(wikitext, "date");
  const publishedAt =
    parsePubDate(dateRaw ?? "") ??
    parsePubDate(revisionTimestamp ?? "") ??
    null;
  if (!publishedAt) return null;

  const title = version ? `${name} (${version})` : name;
  const url =
    link && /^https?:\/\//i.test(link)
      ? link
      : `https://wiki.albiononline.com/wiki/${encodeURIComponent(
          fallbackTitle.replace(/ /g, "_")
        )}`;
  const excerpt = excerptFromHtml(wikiIntro(wikitext));
  return { title, url, publishedAt, excerpt };
}

function wikiField(wikitext: string, field: string): string | null {
  const re = new RegExp(`\\|\\s*${field}\\s*=\\s*(.+)`, "i");
  const match = wikitext.match(re);
  let value = match?.[1]?.trim() ?? "";
  const external = value.match(/^\[(https?:\/\/\S+)\s[^\]]*\]$/i);
  if (external?.[1]) value = external[1];
  value = value.replace(/\[\[|\]\]/g, "").trim();
  return value ? value : null;
}

function wikiIntro(wikitext: string): string {
  const afterInfobox = wikitext.replace(/\{\{Patch infobox[\s\S]*?\n\}\}/i, "");
  const para = afterInfobox.trim().split(/\n\n/)[0] ?? "";
  return para
    .replace(/'{2,}/g, "")
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/\{\{[^}]+\}\}/g, "");
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (char) => char.toUpperCase());
}
