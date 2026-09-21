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
          if (obj.examName) payloads.set(obj.examName, obj as { examName: string; creditEvaluation?: { json?: unknown } });
        } catch { /* not the payload line */ }
      }
    } catch { /* stream closed */ }
  });

  await page.goto("https://www.psu.edu/admission/undergraduate/credit/ap-credit", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  for (let pageNo = 1; pageNo <= 6; pageNo++) {
    const cardTitles: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll("div[role='button'] h4")).map((h) => h.textContent?.trim() ?? "").filter(Boolean),
    );
    console.log(`[ap] list page ${pageNo}: ${cardTitles.length} cards`);
    for (const title of cardTitles) {
      if (payloads.has(title)) continue;
      try {
        await page.locator(`h4:has-text("${title.replace(/"/g, '\\"')}")`).first().click({ timeout: 6000, force: true });
        await page.waitForTimeout(1200);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
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
  await browser.close();
  console.log(`[ap] captured ${payloads.size} exam payloads`);

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
