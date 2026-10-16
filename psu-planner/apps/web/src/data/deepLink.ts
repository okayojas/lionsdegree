/** Opening the planner on a set of programs someone else chose.
 *
 * `/plan/?programs=slug-a+slug-b+slug-c`
 *
 * The handoff between an assistant and the planner. Discovery runs in the
 * student's own AI — it is the only surface with a model, since there is no
 * hosted advisor — and the assistant returns one of these. The engine then
 * generates the real four-year plan from the published suggested-plan grids
 * and the flowchart draws it.
 *
 * The AI never touches the plan. It chooses which programs to feed the
 * generator, and the generator is the same deterministic code onboarding has
 * always run. That boundary is the point: a model that could write terms
 * directly could write a term that does not satisfy the degree.
 *
 * Slugs are VALIDATED against the shipped catalog before anything is loaded.
 * A link is attacker-controlled text, and a program name invented by a model
 * that got no results is exactly the failure this project exists not to
 * commit — so an unknown slug is dropped and reported, never fetched.
 */

/** Separator in the query string. `+` is a space once decoded, which reads
 * better in a URL than repeated `programs=` pairs and survives being pasted
 * into a chat window. */
const SEP = /[+\s,]+/;

export interface DeepLinkRequest {
  /** Slugs that exist in the catalog, in the order given. */
  slugs: string[];
  /** Slugs asked for that no program matches. Surfaced, never silently
   * dropped: a student told "here is your plan" should know if one of the
   * three things they were promised is missing from it. */
  unknown: string[];
}

/**
 * Read a program request out of a query string.
 *
 * Returns `null` when there is no request at all, which is the ordinary case
 * — a student opening the planner normally must not be routed through any of
 * this.
 */
export function parseProgramLink(search: string, known: ReadonlySet<string>): DeepLinkRequest | null {
  const raw = new URLSearchParams(search).get("programs");
  if (!raw?.trim()) return null;

  const slugs: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.trim().split(SEP)) {
    const slug = part.trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    // A cap on the TOTAL, because the query string is attacker-controlled
    // and nobody is enrolled in nine credentials. Counting only the valid
    // ones let forty invented slugs through to be reported one by one,
    // which is a denial-of-service against the error message.
    if (slugs.length + unknown.length >= 6) break;
    (known.has(slug) ? slugs : unknown).push(slug);
  }
  if (!slugs.length && !unknown.length) return null;
  return { slugs, unknown };
}

/** Build the link an assistant hands back. */
export function programLink(origin: string, slugs: string[]): string {
  return `${origin.replace(/\/$/, "")}/plan/?programs=${slugs.map(encodeURIComponent).join("+")}`;
}
