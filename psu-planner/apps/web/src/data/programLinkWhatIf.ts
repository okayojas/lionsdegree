/** A link to a Program, followed by a student who already has a Plan (#69).
 *
 * `?programs=` was written for a student with no Plan: onboarding reads it
 * and starts with those Programs chosen. A student who already had a Plan
 * got their Plan and no word about the link, which is the wrong answer to
 * "Open in the planner" on the Sample plans page. The safe answer is a
 * what-if: a copy of their Plan with the Program in it, and the Plan left
 * exactly as it was.
 *
 * Slugs are checked against the catalog's own index before anything is
 * asked for, as onboarding does: the query string is whatever somebody
 * typed, and a Program a model invented must not become a request.
 */
import { parseProgramLink } from "./deepLink";
import { loadProgramsIndex } from "./catalogClient";
import { usePlanner } from "../store";

/** Follow the Program link in `search`, if there is one. Returns what to
 * tell the student, or `null` where the address carries no such link. */
export async function followProgramLink(search: string): Promise<string | null> {
  if (!new URLSearchParams(search).has("programs")) return null;
  const index = await loadProgramsIndex();
  const req = parseProgramLink(search, new Set(index.map((p) => p.slug)));
  if (!req) return null;

  const strangers = req.unknown.length
    ? ` (This link also names ${req.unknown.join(", ")}, which the catalog does not have.)`
    : "";
  const chosen = req.slugs.flatMap((slug) => index.filter((p) => p.slug === slug));
  if (!chosen.length) {
    return `That link names a program the catalog does not have, so nothing was opened. Your plan is untouched.${strangers}`;
  }

  const store = usePlanner.getState;
  const before = store().plan?.candidates?.length ?? 0;
  // A major first: it takes the place of the student's major, and the
  // rest are added beside it.
  const [first, ...rest] = [...chosen].sort((a, b) => Number(b.type === "major") - Number(a.type === "major"));
  let said = await store().openProgramAsWhatIf(first!);
  const made = (store().plan?.candidates?.length ?? 0) > before && store().candidateId !== null;
  if (made) {
    // The rest go into the what-if that was just made, which is in view.
    const failed: string[] = [];
    for (const p of rest) {
      await store().addProgramNow(p.slug);
      if (!store().plan?.programs.includes(p.slug)) failed.push(p.name);
    }
    if (rest.length) {
      const added = rest.filter((p) => !failed.includes(p.name)).map((p) => p.name);
      said =
        `Opened ${[first!.name, ...added].join(" and ")} as a what-if: a copy of your plan with ` +
        `${added.length ? "them" : "it"} in. Your plan is untouched.` +
        (failed.length ? ` ${failed.join(" and ")} could not be loaded and ${failed.length === 1 ? "is" : "are"} not in it.` : "");
    }
  }
  return said + strangers;
}

/** The address without the Program link, so that a reload, or the back
 * button, does not follow it a second time. */
export function withoutProgramLink(url: URL): string {
  const next = new URL(url.href);
  next.searchParams.delete("programs");
  return next.pathname + next.search + next.hash;
}
