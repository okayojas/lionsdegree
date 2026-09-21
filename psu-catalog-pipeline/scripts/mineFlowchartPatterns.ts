/** Mine AGGREGATE scheduling priors from the 28 official Engineering Advising
 * flowcharts (data/flowcharts/parsed.json, produced by parse_flowcharts.py).
 *
 * The optimizer used to hard-code one student's spreadsheet habits. Instead we
 * learn the shape real PSU engineering plans share — credits/semester, gen-ed
 * cadence, the rise of advanced (400-level) work, when electives can start, and
 * where capstones sit — so a program WITHOUT its own flowchart still gets a
 * plan whose rhythm matches the ones that do.
 *
 * Strictly deterministic statistics over already-parsed course placements plus
 * the course catalog (credits / gen-ed tags / titles). NO LLM output enters the
 * dataset (iron rule 1) — the flowchart PDFs remain the source of truth.
 *
 * Output: data/out/<edition>/flowchart-patterns.json  (shape mirrors the
 * engine's FlowchartPatterns interface; the web app syncs it into the catalog
 * and passes it to optimizeSchedule).
 *
 * Run: npx tsx scripts/mineFlowchartPatterns.ts [--edition 2025-2026]
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const edition = arg("edition") ?? config.edition;
const outDir = config.outDir(edition);
const flowDir = path.resolve(outDir, "../../flowcharts");

const CAPSTONE_TITLE = /\b(capstone|culminating|thesis|senior\s+(design|research|project|thesis)|(design|research)\s+project|project\s+design)\b/i;
const CURVE_LEN = 8; // canonical engineering plan length

interface Course { code: string; number: string; title: string; genEd: string[]; creditsParsed: { min: number } | null }

// ---- Load the course catalog (code -> facts) --------------------------------
const cat = new Map<string, Course>();
for (const dir of ["courses", "courses/grad"]) {
  const d = path.join(outDir, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(d, f), "utf-8")) as Course[]) cat.set(c.code, c);
  }
}
const creditsOf = (code: string) => cat.get(code)?.creditsParsed?.min ?? 3;
const levelOf = (code: string) => parseInt(cat.get(code)?.number ?? code.split(" ")[1] ?? "0", 10) || 0;
const isGenEd = (code: string) => (cat.get(code)?.genEd?.length ?? 0) > 0;
const isCapstone = (code: string) => CAPSTONE_TITLE.test(cat.get(code)?.title ?? "");

// ---- Aggregate over every chart --------------------------------------------
const parsed: Record<string, Record<string, string[]>> = JSON.parse(fs.readFileSync(path.join(flowDir, "parsed.json"), "utf-8"));

const geBuckets = Array.from({ length: CURVE_LEN }, () => ({ sum: 0, n: 0 }));
const advBuckets = Array.from({ length: CURVE_LEN }, () => ({ sum: 0, n: 0 }));
const creditSamples: number[] = [];
const electiveOnsets: number[] = [];
const capstoneStarts: number[] = [];
const capstoneSeqLens: number[] = [];
let chartsUsed = 0;
const chartNames: string[] = [];

for (const [pdf, chart] of Object.entries(parsed)) {
  const sems = Object.keys(chart).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  if (sems.length < 4) continue; // parse too sparse to trust
  chartsUsed++;
  chartNames.push(pdf);
  const n = sems.length;

  let firstAdvancedFrac = 1;
  let firstCapstoneFrac = 1;
  const capstoneSubjects = new Map<string, number>();

  sems.forEach((sem, i) => {
    const codes = (chart[String(sem)] ?? []).filter((c) => cat.has(c));
    const frac = n > 1 ? i / (n - 1) : 0;
    const bucket = Math.round(frac * (CURVE_LEN - 1));

    // credits/sem
    creditSamples.push(codes.reduce((s, c) => s + creditsOf(c), 0));
    // gen-ed cadence
    geBuckets[bucket].sum += codes.filter(isGenEd).length;
    geBuckets[bucket].n += 1;
    // advanced (400-level) share
    const adv = codes.filter((c) => levelOf(c) >= 400).length;
    advBuckets[bucket].sum += codes.length ? adv / codes.length : 0;
    advBuckets[bucket].n += 1;
    if (adv > 0 && frac < firstAdvancedFrac) firstAdvancedFrac = frac;
    // capstone position + same-subject sequence length
    for (const c of codes.filter(isCapstone)) {
      if (frac < firstCapstoneFrac) firstCapstoneFrac = frac;
      const subj = c.split(" ")[0];
      capstoneSubjects.set(subj, (capstoneSubjects.get(subj) ?? 0) + 1);
    }
  });

  electiveOnsets.push(firstAdvancedFrac);
  if (firstCapstoneFrac < 1) {
    capstoneStarts.push(firstCapstoneFrac);
    capstoneSeqLens.push(Math.max(...capstoneSubjects.values()));
  }
}

// ---- Suggested-plan curves (all ~1,000 templates, a far larger sample than
// the 28 charts): where do prescribed courses, elective placeholders, and
// gen-ed slots sit across a plan? Confirms the front-load-core /
// phase-in-electives shape and gives the optimizer its placement weights. ----
const elBuckets = new Array(CURVE_LEN).fill(0);
const geSlotBuckets = new Array(CURVE_LEN).fill(0);
const crsBuckets = new Array(CURVE_LEN).fill(0);
let templatesUsed = 0;
{
  const majorsDir = path.join(outDir, "programs/majors");
  for (const f of fs.existsSync(majorsDir) ? fs.readdirSync(majorsDir) : []) {
    let prog: { suggestedPlans?: { semesters?: { entries?: { type: string; label?: string }[] }[] }[] };
    try { prog = JSON.parse(fs.readFileSync(path.join(majorsDir, f), "utf-8")); } catch { continue; }
    for (const sp of prog.suggestedPlans ?? []) {
      const sems = sp.semesters ?? [];
      if (sems.length < 4) continue;
      templatesUsed++;
      sems.forEach((s, i) => {
        const b = Math.round((sems.length > 1 ? i / (sems.length - 1) : 0) * (CURVE_LEN - 1));
        for (const e of s.entries ?? []) {
          if (e.type === "course") crsBuckets[b]++;
          else if (e.type === "genEd") geSlotBuckets[b]++;
          else if (e.type === "placeholder" && !/first.year|seminar/i.test(e.label ?? "")) elBuckets[b]++;
        }
      });
    }
  }
}
const asShare = (a: number[]) => {
  const t = a.reduce((x, y) => x + y, 0) || 1;
  return a.map((v) => Math.round((v / t) * 1000) / 1000);
};

// ---- Reduce to the FlowchartPatterns shape ----------------------------------
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

const patterns = {
  source: `${chartsUsed} engineering advising flowcharts (parsed.json) + ${templatesUsed} bulletin suggested plans, edition ${edition}`,
  numChartsUsed: chartsUsed,
  targetCreditsPerSem: round1(mean(creditSamples.filter((c) => c > 0))),
  capCreditsPerSem: 19, // PSU full-time tuition ceiling (user rule) — a hard cap, not mined
  geCurve: geBuckets.map((b) => round2(b.n ? b.sum / b.n : 0)),
  advancedCurve: advBuckets.map((b) => round2(b.n ? b.sum / b.n : 0)),
  electiveOnsetFrac: round2(median(electiveOnsets)),
  /** Share of elective placeholders / prescribed courses per normalized
   * position across ALL suggested plans — the bulletin's own shape: core
   * front-loaded, technical electives phased in toward the capstone. */
  electiveCurve: asShare(elBuckets),
  prescribedCurve: asShare(crsBuckets),
  geSlotCurve: asShare(geSlotBuckets),
  numTemplatesUsed: templatesUsed,
  capstone: {
    meanStartFrac: round2(capstoneStarts.length ? mean(capstoneStarts) : 0.8),
    maxSeqLen: capstoneSeqLens.length ? Math.max(...capstoneSeqLens) : 3,
  },
  generatedFrom: chartNames,
};

const outPath = path.join(outDir, "flowchart-patterns.json");
fs.writeFileSync(outPath, JSON.stringify(patterns, null, 2));
console.log(`[mineFlowchartPatterns] ${chartsUsed} charts -> ${outPath}`);
console.log(`  targetCreditsPerSem=${patterns.targetCreditsPerSem} electiveOnsetFrac=${patterns.electiveOnsetFrac} capstone.start=${patterns.capstone.meanStartFrac} seqLen=${patterns.capstone.maxSeqLen}`);
console.log(`  geCurve=[${patterns.geCurve.join(", ")}]`);
console.log(`  advancedCurve=[${patterns.advancedCurve.join(", ")}]`);
console.log(`  electiveCurve=[${patterns.electiveCurve.join(", ")}] (${templatesUsed} templates)`);
console.log(`  prescribedCurve=[${patterns.prescribedCurve.join(", ")}]`);
