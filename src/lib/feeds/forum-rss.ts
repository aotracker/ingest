import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ForumPatchNoteItem } from "../db/schema";

export const PATCH_NOTES_RSS_URL =
  "https://forum.albiononline.com/index.php/BoardFeed/114/";

export const PATCH_NOTES_BOARD_URL =
  "https://forum.albiononline.com/index.php/Board/114-Patch-Notes/";

const TIMEOUT_MS = 20_000;
const EXCERPT_MAX_CHARS = 280;
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ACCEPT =
  "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8";
const COOKIE_JAR = join(tmpdir(), "aotracker-forum-rss-cookies.txt");
const BODY_FILE = join(tmpdir(), "aotracker-forum-rss-body.xml");

const execFileAsync = promisify(execFile);

export type { ForumPatchNoteItem };

export async function fetchForumPatchNotesRss(): Promise<ForumPatchNoteItem[]> {
  const body = await fetchForumRssBody();
  assertRssBody("", body);
  return parseForumRssItems(body);
}

async function fetchForumRssBody(): Promise<string> {
  try {
    return await fetchRssWithCurl();
  } catch (err) {
    if (!isCurlMissing(err)) throw err;
    console.warn("[patch-notes] curl not found, falling back to Node fetch");
    return fetchRssWithNode();
  }
}

function isCurlMissing(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function fetchRssWithCurl(): Promise<string> {
  const run = async (): Promise<{ status: number; body: string }> => {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "curl.exe" : "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        String(Math.ceil(TIMEOUT_MS / 1000)),
        "-A",
        CHROME_UA,
        "-H",
        `Accept: ${ACCEPT}`,
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        `Referer: ${PATCH_NOTES_BOARD_URL}`,
        "-c",
        COOKIE_JAR,
        "-b",
        COOKIE_JAR,
        "-o",
        BODY_FILE,
        "-w",
        "%{http_code}",
        PATCH_NOTES_RSS_URL,
      ],
      { timeout: TIMEOUT_MS + 5_000, windowsHide: true, maxBuffer: 2_000_000 }
    );
    const status = Number.parseInt(stdout.trim(), 10);
    const body = await readFile(BODY_FILE, "utf8");
    return { status: Number.isFinite(status) ? status : 0, body };
  };

  let result = await run();
  if (result.status === 403 || isCloudflareChallenge(result.body)) {
    await sleep(1500);
    result = await run();
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Forum RSS HTTP ${result.status}`);
  }
  return result.body;
}

async function fetchRssWithNode(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(PATCH_NOTES_RSS_URL, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: ACCEPT,
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": CHROME_UA,
        Referer: PATCH_NOTES_BOARD_URL,
      },
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Forum RSS HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function isCloudflareChallenge(body: string): boolean {
  const head = body.slice(0, 800);
  return (
    /just a moment/i.test(head) ||
    /cf-mitigated/i.test(head) ||
    /challenges\.cloudflare\.com/i.test(head)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function assertRssBody(contentType: string, body: string): void {
  const trimmed = body.trimStart();
  const looksLikeHtml =
    /^<!DOCTYPE html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  const head = trimmed.slice(0, 800);
  const looksLikeRss = /^<\?xml/i.test(trimmed) || /<rss[\s>]/i.test(head);

  if (looksLikeHtml || !looksLikeRss) {
    const typeHint = contentType ? ` (content-type ${contentType})` : "";
    throw new Error(`Forum RSS returned a non-XML body${typeHint}`);
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

function excerptFromHtml(html: string): string {
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

function parsePubDate(raw: string): string | null {
  if (!raw.trim()) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
