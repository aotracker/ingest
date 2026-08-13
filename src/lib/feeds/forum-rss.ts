import type { ForumPatchNoteItem } from "../db/schema";
import { fetchUrlWithCurl } from "./curl-fetch";

export const PATCH_NOTES_RSS_URL =
  "https://forum.albiononline.com/index.php/BoardFeed/114/";

export const PATCH_NOTES_BOARD_URL =
  "https://forum.albiononline.com/index.php/Board/114-Patch-Notes/";

export const PATCH_NOTES_CHANGELOG_URL = "https://albiononline.com/changelog";

const EXCERPT_MAX_CHARS = 280;

export type { ForumPatchNoteItem };

export async function fetchForumPatchNotesRss(): Promise<ForumPatchNoteItem[]> {
  const body = await fetchUrlWithCurl(PATCH_NOTES_RSS_URL, {
    accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    referer: PATCH_NOTES_BOARD_URL,
  });
  assertRssBody(body);
  const items = parseForumRssItems(body);
  if (items.length === 0) {
    throw new Error("Forum RSS contained no patch note items");
  }
  return items;
}

export function parseForumRssItems(xml: string): ForumPatchNoteItem[] {
  const items: ForumPatchNoteItem[] = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[0];
    const title = decodeRssText(readRssField(block, "title"));
    const link = cleanForumUrl(
      decodeRssText(readRssField(block, "link") || readRssField(block, "guid"))
    );
    const publishedAt = parsePubDate(readRssField(block, "pubDate"));
    if (!title || !link || !publishedAt) continue;

    items.push({
      title,
      url: link,
      publishedAt,
      excerpt: excerptFromHtml(readRssField(block, "description")),
    });
  }

  return items;
}

function assertRssBody(body: string): void {
  const trimmed = body.trimStart();
  const looksLikeHtml =
    /^<!DOCTYPE html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  const head = trimmed.slice(0, 800);
  const looksLikeRss = /^<\?xml/i.test(trimmed) || /<rss[\s>]/i.test(head);

  if (looksLikeHtml || !looksLikeRss) {
    throw new Error("Forum RSS returned a non-XML body");
  }
}

function readRssField(block: string, tag: string): string {
  const cdata = new RegExp(
    `<${tag}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i"
  );
  const cdataMatch = block.match(cdata);
  if (cdataMatch?.[1] != null) return cdataMatch[1];

  const plain = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const plainMatch = block.match(plain);
  return plainMatch?.[1]?.trim() ?? "";
}

function decodeRssText(value: string): string {
  return decodeHtmlEntities(value).trim();
}

export function excerptFromHtml(html: string): string {
  const text = decodeHtmlEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= EXCERPT_MAX_CHARS) return text;

  const sliced = text.slice(0, EXCERPT_MAX_CHARS);
  const lastSpace = sliced.lastIndexOf(" ");
  const clipped = (lastSpace > 80 ? sliced.slice(0, lastSpace) : sliced).trimEnd();
  return `${clipped}…`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => fromCodePointSafe(parseInt(num, 10)));
}

function fromCodePointSafe(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function cleanForumUrl(url: string): string {
  const raw = url.trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    parsed.searchParams.delete("s");
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.split("?")[0] ?? raw;
  }
}

export function parsePubDate(raw: string): string | null {
  if (!raw.trim()) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
