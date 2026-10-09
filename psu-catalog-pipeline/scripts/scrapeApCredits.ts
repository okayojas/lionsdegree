/** Scrape PSU's AP credit awards. The psu.edu page loads per-exam data via a
 * Next.js server action; we click every exam card in a headless browser and
 * capture the action responses — clean CMS JSON, parsed deterministically
 * (no LLM). Course references arrive as prose ("Chemistry 110 and 111"), so
 * subject names map to prefixes via the already-scraped subject index.
 *
 * Output: data/out/<edition>/ap_credits.json
 * Run: npx tsx scripts/scrapeApCredits.ts [--edition 2025-2026]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { config } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const edition = arg("edition") ?? config.edition;

/* ---------- subject-name -> prefix map from the cached subject index ---------- */
function subjectNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const level of ["undergraduate", "graduate"]) {
    const f = path.join(config.rawDir(edition), `university-course-descriptions_${level}.html`);
    if (!fs.existsSync(f)) continue;
    const $ = cheerio.load(fs.readFileSync(f, "utf-8"));
    $("a").each((_, a) => {
      const text = $(a).text().trim();
      const m = /^(.+?)\s*\(([A-Z\s-]+)\)\s*$/.exec(text);
      if (m) map.set(m[1].toLowerCase(), m[2].replace(/[\s-]/g, ""));
    });
  }
  // Prose in the AP text sometimes uses shorthand
  map.set("math", map.get("mathematics") ?? "MATH");
  map.set("chem", "CHEM");
  return map;
}

/* ---------- rich-text parsing ---------- */
interface ApAward { minScore: number; courses: string[]; credits: number | null; raw: string }
interface ApExam { exam: string; awards: ApAward[]; notes: string[] }

function textOfNode(n: unknown): string {
  const node = n as { value?: string; content?: unknown[] };
  if (node.value) return node.value;
  return (node.content ?? []).map(textOfNode).join("");
}

const SCORE_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function parseAwardSentence(sentence: string, subjects: Map<string, string>): ApAward | { note: string } | null {
  const scoreM = /grade of (one|two|three|four|five|\d)/i.exec(sentence);
  if (!scoreM) return null;
  const score = SCORE_WORDS[scoreM[1].toLowerCase()] ?? parseInt(scoreM[1], 10);
  if (/no credit/i.test(sentence)) return { minScore: score, courses: [], credits: 0, raw: sentence };

  const creditsM = /\((\d+(?:\.\d+)?)\s*credits?\)/i.exec(sentence);
  // Course refs: "<Subject Name> 110, 111, and 112" — subject = longest name
  // match from the index; numbers share it.
  const courses: string[] = [];
  const re = /([A-Z][A-Za-z&' .-]{2,40}?)\s+(\d{1,3}[A-Z]{0,2})((?:\s*(?:,|and|or)\s*\d{1,3}[A-Z]{0,2})*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    // Try progressively shorter suffixes of the name phrase against the index.
    const words = m[1].trim().split(/\s+/);
    let prefix: string | undefined;
    const last = words[words.length - 1];
    if (/^[A-Z]{2,6}$/.test(last)) prefix = last; // already a code prefix (AFAM 110, GENED 197)
    for (let take = Math.min(4, words.length); take >= 1 && !prefix; take--) {
      const candidate = words.slice(-take).join(" ").toLowerCase().replace(/^(for|to|of|the|and)\s+/, "");
      prefix = subjects.get(candidate);
    }
    if (!prefix) continue;
    const normNum = (num: string) => num.replace(/^0+(?=\d)/, "");
    courses.push(`${prefix} ${normNum(m[2])}`);
    for (const extra of m[3].matchAll(/\d{1,3}[A-Z]{0,2}/g)) courses.push(`${prefix} ${normNum(extra[0])}`);
  }
  if (/general credit/i.test(sentence) && !courses.length) {
    return { minScore: score, courses: [], credits: creditsM ? parseFloat(creditsM[1]) : null, raw: sentence };
  }
  return { minScore: score, courses: [...new Set(courses)], credits: creditsM ? parseFloat(creditsM[1]) : null, raw: sentence };
}

/* ---------- browser walk ---------- */
async function main() {
  const subjects = subjectNameMap();
  console.log(`[ap] subject-name map: ${subjects.size} names`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "LionsDegree-pipeline/0.1 (+https://github.com/okayojas/lionsdegree)" });
  const payloads = new Map<string, { examName: string; creditEvaluation?: { json?: unknown } }>();
  page.on("response", async (r) => {
    if (r.request().method() !== "POST" || !r.url().includes("ap-credit")) return;
    try {
      const text = await r.text();
      // RSC flight: lines "1:{...json...}"
      for (const line of text.split("\n")) {
        const jm = /^\d+:(\{.*\})\s*$/.exec(line);
        if (!jm) continue;
        try {
          const obj = JSON.parse(jm[1]) as { examName?: string; creditEvaluation?: { json?: unknown } };
          // Trim: at least one exam ships with trailing spaces in the payload
          // ("Cybersecurity  "), and this name is both the lookup key and the
          // label a student picks from.
          if (obj.examName) {
            const name = obj.examName.replace(/\s+/g, " ").trim();
            payloads.set(name, { ...obj, examName: name } as { examName: string; creditEvaluation?: { json?: unknown } });
          }
        } catch { /* not the payload line */ }
      }
    } catch { /* stream closed */ }
  });

  await page.goto("https://www.psu.edu/admission/undergraduate/credit/ap-credit", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  /** Minimum time to spend per exam card, matching the pace this scrape ran at
   * before payload polling made it faster. The shared fetcher's 1 req/s rule
   * does not cover browser-driven clicks, so the floor is enforced here. */
  const MIN_PER_CARD_MS = 1500;

  /** Every exam card the listing offered, across all pagination pages. The
   * capture is complete only when we hold a payload for each one. */
  const seen = new Set<string>();

  /** Walk every pagination page, clicking the cards we do not yet hold a
   * payload for. Returns once the walk ends; call again to retry stragglers. */
  async function sweep(waitMs: number): Promise<void> {
    for (let pageNo = 1; pageNo <= 6; pageNo++) {
      const cardTitles: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("div[role='button'] h4")).map((h) => h.textContent?.trim() ?? "").filter(Boolean),
      );
      // Normalized the SAME way payload names are. A heading whose markup
      // wraps carries newlines and indentation, so it never matched its
      // payload, got re-clicked on all three sweeps, and polled the full
      // timeout each time -- tripling the requests the per-card floor exists
      // to limit.
      cardTitles.forEach((t) => seen.add(t.replace(/\s+/g, " ").trim()));
      console.log(`[ap] list page ${pageNo}: ${cardTitles.length} cards`);
      for (const raw of cardTitles) {
        const title = raw.replace(/\s+/g, " ").trim();
        if (payloads.has(title)) continue;
        try {
          await page.locator(`h4:has-text("${raw.replace(/"/g, '\\"')}")`).first().click({ timeout: 6000, force: true });
          // POLL for the payload rather than guessing a fixed delay. A flat
          // 1200ms wait silently dropped 8 of 45 exams (Spanish, French,
          // German, Chinese, Physics 2 among them) whenever the server action
          // came back slower than the guess.
          const started = Date.now();
          const deadline = started + waitMs;
          while (!payloads.has(title) && Date.now() < deadline) await page.waitForTimeout(150);
          if (!payloads.has(title)) console.log(`  [ap] no payload yet: ${title}`);
          await page.keyboard.press("Escape");
          // Politeness floor. Polling returns as soon as the payload lands,
          // which would otherwise let us click faster than the old fixed wait
          // did -- and retry sweeps multiply that. Each card costs psu.edu at
          // least one server action, so hold the old ~1.5s per-card pace.
          const spent = Date.now() - started;
          await page.waitForTimeout(Math.max(250, MIN_PER_CARD_MS - spent));
        } catch { console.log(`  [ap] click failed: ${title}`); }
      }
      // Next pagination page: a button/link with the bare number.
      const moved = await page.evaluate((n) => {
        const el = document.querySelector(`li[aria-label="Go to page ${n}"]`);
        if (el) { (el as HTMLElement).click(); return true; }
        return false;
      }, pageNo + 1);
      if (!moved) break;
      await page.waitForTimeout(2500);
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    await sweep(attempt * 6000);
    const missing = [...seen].filter((t) => !payloads.has(t));
    if (!missing.length) break;
    console.log(`[ap] attempt ${attempt}: ${missing.length} still missing, retrying — ${missing.join(", ")}`);
    await page.goto("https://www.psu.edu/admission/undergraduate/credit/ap-credit", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(5000);
  }
  await browser.close();

  console.log(`[ap] captured ${payloads.size} of ${seen.size} exam payloads`);

  // Iron rule 2: a partial AP table is worse than none. A student holding an
  // exam we dropped would silently receive no credit for it, which reads as a
  // planner bug and costs them real course placement. The original script
  // waited a flat 1200ms per card and wrote whatever it happened to have --
  // 37 of 45 on one run, silently dropping Spanish, French, German, Chinese
  // and Physics 2. Fail rather than write a partial table.
  const cardOnly = [...seen].filter((t) => !payloads.has(t));
  const payloadOnly = [...payloads.keys()].filter((n) => !seen.has(n));

  // MEMBERSHIP, not counts. Comparing payloads.size < seen.size let the exact
  // failure this guard exists for slip through: one card goes unmatched while
  // an extra payload arrives under a different name, the sizes tie, and a
  // partial table is written with nothing but a console NOTE. A card that
  // produced no payload is lost data however the totals happen to land.
  if (cardOnly.length) {
    throw new Error(
      `AP capture incomplete: ${payloads.size} payloads for ${seen.size} cards after 3 attempts ` +
        `(no payload for: ${cardOnly.join(", ")}). Refusing to write a partial ap_credits.json.`,
    );
  }

  // Every card produced a payload, so nothing was lost -- but a payload whose
  // examName is not a card heading means that exam is filed under a name the
  // listing does not use, which is worth saying out loud.
  if (payloadOnly.length) {
    console.log(
      `[ap] NOTE: payload examName(s) [${payloadOnly.join(", ")}] are not card headings. ` +
        `Payload names are authoritative.`,
    );
  }

  const exams: ApExam[] = [];
  for (const [name, payload] of payloads) {
    const doc = payload.creditEvaluation?.json as { content?: unknown[] } | undefined;
    if (!doc?.content) continue;
    const awards: ApAward[] = [];
    const notes: string[] = [];
    for (const block of doc.content) {
      const sentence = textOfNode(block).trim();
      if (!sentence || /^penn state credit evaluation$/i.test(sentence)) continue;
      const parsed = parseAwardSentence(sentence, subjects);
      if (parsed && "minScore" in parsed) awards.push(parsed);
      else if (sentence.length > 3) notes.push(sentence.slice(0, 300));
    }
    exams.push({ exam: name, awards: awards.sort((a, b) => a.minScore - b.minScore), notes });
  }
  exams.sort((a, b) => a.exam.localeCompare(b.exam));

  const outFile = path.join(config.outDir(edition), "ap_credits.json");
  fs.writeFileSync(outFile, JSON.stringify({
    source: "https://www.psu.edu/admission/undergraduate/credit/ap-credit",
    scrapedAt: new Date().toISOString(),
    method: "server-action capture + deterministic parse",
    note: "Awards change and department acceptance varies — students should verify with their adviser.",
    exams,
  }, null, 1), "utf-8");
  const withCourses = exams.filter((e) => e.awards.some((a) => a.courses.length));
  console.log(`[ap] wrote ${exams.length} exams (${withCourses.length} with parsed course awards) -> ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
