/** Polite serial fetcher with a disk cache.
 * - 1 req/s (+jitter), custom User-Agent, 3x exponential backoff on 5xx/network.
 * - Hard-fails the run on repeated 403 (we're blocked; stop, don't hammer).
 * - Every page is cached under data/raw/<edition>/ so re-parsing never re-fetches.
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.js";

let lastRequestAt = 0;
let consecutive403 = 0;

function cachePath(edition: string, urlPath: string): string {
  const safe = urlPath.replace(/^\//, "").replace(/\/$/, "").replace(/[^a-zA-Z0-9-_.]/g, "_") || "index";
  return path.join(config.rawDir(edition), safe + ".html");
}

export interface FetchResult {
  html: string;
  fromCache: boolean;
}

export async function fetchPage(urlPath: string, opts: { edition: string; force?: boolean }): Promise<FetchResult> {
  const file = cachePath(opts.edition, urlPath);
  if (!opts.force && fs.existsSync(file)) {
    return { html: fs.readFileSync(file, "utf-8"), fromCache: true };
  }

  const url = config.baseUrl + urlPath;
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + config.requestDelayMs + Math.random() * config.requestJitterMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    let res: Response | null = null;
    let err: unknown = null;
    try {
      res = await fetch(url, { headers: { "User-Agent": config.userAgent } });
    } catch (e) {
      err = e;
    }

    if (res?.ok) {
      consecutive403 = 0;
      const html = await res.text();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html, "utf-8");
      return { html, fromCache: false };
    }

    if (res?.status === 403 && ++consecutive403 >= 3) {
      throw new Error(`Blocked: 3 consecutive 403 responses (last: ${url}). Stopping the crawl.`);
    }
    if (res && res.status >= 400 && res.status < 500 && res.status !== 403 && res.status !== 429) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    if (attempt >= config.maxRetries) {
      throw new Error(`Failed after ${attempt + 1} attempts: ${url} (${res ? "HTTP " + res.status : String(err)})`);
    }
    await sleep(2000 * Math.pow(2, attempt));
  }
}
