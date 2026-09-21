/** Aggregate scheduling priors mined from the 28 official Engineering Advising
 * flowcharts (advising.engr.psu.edu). The optimizer consumes these to shape a
 * plan the way real PSU engineering plans are shaped — instead of hard-coding
 * one student's spreadsheet habits — so that a program WITHOUT an official
 * flowchart still gets a plan whose rhythm matches the ones that do.
 *
 * Produced deterministically by `psu-catalog-pipeline/scripts/mineFlowchartPatterns.ts`
 * (stats over parsed.json + the course catalog — never LLM output; iron rule 1).
 * The engine ships the DEFAULTS below so it stays pure and unit-testable with
 * no pipeline dependency; the web app passes the mined file in when present.
 *
 * All *Curve arrays are length-8 (the canonical engineering plan length) and
 * indexed by normalized semester position: bucket = round(frac * 7) where
 * frac = semIndex / (numSemesters - 1). Plans of other lengths sample the
 * curve by fraction, so an accelerated or extended plan still gets the same
 * front-to-back shape. */
export interface FlowchartPatterns {
  /** Provenance for the review UI / debugging — which charts fed the stats. */
  source: string;
  numChartsUsed: number;
  /** Mean scheduled credits per semester across all charts (~15-18 at PSU). */
  targetCreditsPerSem: number;
  /** Hard per-semester ceiling. 19 = PSU full-time tuition cap (user rule);
   * the packer may use all of it, no artificial headroom. */
  capCreditsPerSem: number;
  /** Mean gen-ed-tagged courses per normalized semester (length 8). Typically
   * ~1/sem, biased slightly early. Drives GE-slot cadence. */
  geCurve: number[];
  /** Fraction of scheduled courses that are 400-level, per normalized semester
   * (length 8). Rises toward the end — the natural elective/advanced gradient. */
  advancedCurve: number[];
  /** Earliest normalized position (0..1) at which undecided elective
   * placeholders should start appearing; before this the plan is
   * prescribed-dense. Median first-400-level position across charts. */
  electiveOnsetFrac: number;
  /** Share of elective PLACEHOLDERS per normalized semester (length 8), mined
   * from ~1,078 bulletin suggested plans: the bulletin front-loads the
   * prescribed core and phases technical electives in toward the capstone
   * (measured: 0.03 -> 0.24). Drives where undecided elective slots land. */
  electiveCurve: number[];
  /** Capstone shape: where senior-design/thesis sequences start and how long
   * they run. Used to anchor detected capstones to the final semesters. */
  capstone: { meanStartFrac: number; maxSeqLen: number };
}

/** Conservative defaults reflecting the canonical 8-semester PSU engineering
 * plan: ~15.5 cr/sem, ~1 GE/sem front-loaded, 400-level work concentrated in
 * the last two years, capstone in the final 1-2 semesters. Overwritten by the
 * mined file when the web app supplies it. */
export const DEFAULT_FLOWCHART_PATTERNS: FlowchartPatterns = {
  source: "engine built-in defaults (canonical PSU engineering plan)",
  numChartsUsed: 0,
  targetCreditsPerSem: 15.5,
  capCreditsPerSem: 19,
  geCurve: [1.2, 1.1, 1.0, 1.0, 0.9, 0.8, 0.6, 0.4],
  advancedCurve: [0.0, 0.0, 0.05, 0.15, 0.35, 0.5, 0.7, 0.8],
  electiveOnsetFrac: 0.4,
  electiveCurve: [0.03, 0.05, 0.08, 0.08, 0.14, 0.17, 0.21, 0.24],
  capstone: { meanStartFrac: 0.8, maxSeqLen: 3 },
};

/** Sample a length-8 normalized curve at an arbitrary semester of an
 * `n`-semester plan. */
export function sampleCurve(curve: number[], semIndex: number, n: number): number {
  if (n <= 1) return curve[0] ?? 0;
  const frac = Math.min(1, Math.max(0, semIndex / (n - 1)));
  const pos = frac * (curve.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(curve.length - 1, lo + 1);
  const t = pos - lo;
  return (curve[lo] ?? 0) * (1 - t) + (curve[hi] ?? 0) * t;
}
