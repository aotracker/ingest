import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const TIMEOUT_MS = 20_000;
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const COOKIE_JAR = join(tmpdir(), "aotracker-feed-cookies.txt");

const execFileAsync = promisify(execFile);

export function isCloudflareChallenge(body: string): boolean {
  const head = body.slice(0, 800);
  return (
    /just a moment/i.test(head) ||
    /cf-mitigated/i.test(head) ||
    /challenges\.cloudflare\.com/i.test(head)
  );
}

export function isCloudflareBlocked(status: number, body: string): boolean {
  return status === 403 || isCloudflareChallenge(body);
}

function curlBin(): string {
  return process.platform === "win32" ? "curl.exe" : "/usr/bin/curl";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchUrlWithCurl(
  url: string,
  options?: { accept?: string; referer?: string }
): Promise<string> {
  const accept =
    options?.accept ??
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  const referer = options?.referer ?? "https://albiononline.com/";

  const bodyFile = join(tmpdir(), `aotracker-feed-${randomUUID()}.body`);

  const run = async (): Promise<{ status: number; body: string }> => {
    const { stdout } = await execFileAsync(
      curlBin(),
      [
        "-sS",
        "-L",
        "--compressed",
        "--max-time",
        String(Math.ceil(TIMEOUT_MS / 1000)),
        "-A",
        CHROME_UA,
        "-H",
        `Accept: ${accept}`,
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        `Referer: ${referer}`,
        "-c",
        COOKIE_JAR,
        "-b",
        COOKIE_JAR,
        "-o",
        bodyFile,
        "-w",
        "%{http_code}",
        url,
      ],
      {
        timeout: TIMEOUT_MS + 5_000,
        windowsHide: true,
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`,
        },
      }
    );
    const status = Number.parseInt(stdout.trim(), 10);
    const body = await readFile(bodyFile, "utf8");
    return { status: Number.isFinite(status) ? status : 0, body };
  };

  try {
    let result = await run();
    if (isCloudflareBlocked(result.status, result.body)) {
      await sleep(1500);
      result = await run();
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status} for ${url}`);
    }
    if (isCloudflareChallenge(result.body)) {
      throw new Error(`Cloudflare challenge for ${url}`);
    }
    return result.body;
  } finally {
    await unlink(bodyFile).catch(() => undefined);
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "AOTracker/1.0 (https://www.aotracker.net; patch-notes)",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } catch {
    const body = await fetchUrlWithCurl(url, {
      accept: "application/json",
      referer: "https://wiki.albiononline.com/",
    });
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
