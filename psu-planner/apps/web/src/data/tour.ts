/** The first-run tour of the planner (#71): which steps there are, and
 * whether a student has seen it.
 *
 * Kept apart from the component so the rules can be tested without a DOM:
 * which steps apply depends on whether there is an account service and
 * whether the student is signed in, and the tour must show once and never
 * nag.
 */

/** Where a step points: the `data-tour` attribute of a real control. */
export type TourAnchor = "chart" | "requirements" | "whatifs" | "menu" | "signin" | "connect" | null;

export interface TourStep {
  id: string;
  title: string;
  body: string;
  anchor: TourAnchor;
}

const ALL: (TourStep & { needs?: "accounts" | "signed-out" })[] = [
  {
    id: "chart",
    title: "This is your plan",
    body:
      "Each column is a term, and the lines are prerequisites. Drag a course to another term and the planner tells you if anything breaks. List view, in the toolbar, shows the same plan as a list.",
    anchor: "chart",
  },
  {
    id: "requirements",
    title: "What your degree still needs",
    body:
      "The requirements panel checks your plan against the Bulletin. To switch majors, press Change program beside its name.",
    anchor: "requirements",
  },
  {
    id: "whatifs",
    title: "Try something without risk",
    body:
      "+ What-if copies your plan into a tab. Try another major, a minor, a summer or a term off; your plan stays as it is. Keep the one you like.",
    anchor: "whatifs",
  },
  {
    id: "menu",
    title: "Add a minor, a master's, or AP credit",
    body:
      "The Menu has Your programs (add a minor or certificate, or change your major), Add a master's degree (IUG), Import courses and AP credit, and Plan history.",
    anchor: "menu",
  },
  {
    id: "signin",
    title: "Keep your plan",
    body:
      "Right now your plan is saved only in this browser. Sign in with Google to keep it and open it on your phone.",
    anchor: "signin",
    needs: "signed-out",
  },
  {
    id: "connect",
    title: "Ask your own AI",
    body:
      "Connect Claude or ChatGPT to ask about your plan in plain words, like \"can I graduate a term early?\". It answers from your real plan.",
    anchor: "connect",
    needs: "accounts",
  },
  {
    id: "done",
    title: "You're set",
    body:
      "This is an unofficial tool: check your plan with your adviser before you register. You can take this tour again from the Menu.",
    anchor: null,
  },
];

/** The steps that apply to this student. */
export function tourSteps(c: { accounts: boolean; signedIn: boolean }): TourStep[] {
  return ALL.filter((s) =>
    s.needs === undefined
      ? true
      : s.needs === "accounts"
        ? c.accounts
        : c.accounts && !c.signedIn,
  ).map(({ needs: _needs, ...step }) => step);
}

const SEEN_KEY = "lionsdegree-tour-done";

/** Has this browser finished or skipped the tour? Where storage cannot be
 * read, yes: a tour that comes back on every visit is worse than one that
 * was never shown. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage disabled: tourSeen already answers yes */
  }
}
