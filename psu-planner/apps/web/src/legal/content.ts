/** Privacy, Terms and Accessibility — written once.
 *
 * These exist in two places at once: a modal inside the planner, and static
 * documents at /privacy and /terms that load with no JavaScript. The static
 * ones are not a nicety. Google and Microsoft both require a publicly
 * reachable privacy-policy URL to verify an OAuth app, and a previewer or a
 * crawler will not run React to find one.
 *
 * Two renderers consume this module (`render.ts` for HTML, `LegalModal.tsx`
 * for React) so the wording cannot drift between them. A hand-maintained
 * second copy is how a privacy policy ends up describing a data flow the
 * product stopped doing -- which is not a style problem, it is an inaccurate
 * privacy policy.
 */

/** Inline run: plain text, bold, italic, or a link. */
export type Inline =
  | string
  | { b: string }
  | { i: string }
  | { a: string; href: string };

export type Block = { p: Inline[] } | { ul: Inline[][] };

export interface Section {
  id: "privacy" | "terms" | "accessibility";
  /** Tab label in the modal. */
  tab: string;
  /** <h1> on the static page, <h3> in the modal. */
  heading: string;
  /** Static page only: <title> and meta description. */
  title: string;
  description: string;
  /** Static page only: the path it is served at. Accessibility has none --
   * it ships in the modal but needs no standalone URL, because nothing
   * external demands one. */
  path?: string;
  body: Block[];
}

export const UPDATED = "October 10, 2026";

/** The one address a student can reach a human at. Deliberately not "open a
 * GitHub issue": a data-access or deletion request is not something to make
 * someone publish under their own name in a public tracker. */
export const CONTACT = "ovk5113@psu.edu";

const repo = { a: "github.com/okayojas/lionsdegree", href: "https://github.com/okayojas/lionsdegree" };
const mail = { a: CONTACT, href: `mailto:${CONTACT}` };

export const SECTIONS: Section[] = [
  {
    id: "privacy",
    tab: "Privacy",
    heading: "Privacy Policy",
    title: "Privacy Policy — LionsDegree",
    description:
      "LionsDegree stores your degree plan in your own browser. No tracking, no analytics, no advertising, no sale of data.",
    path: "/privacy/",
    body: [
      { p: [{ b: "The short version:" }, " your degree plan lives in your browser, not on our servers. We set no cookies and run no analytics."] },
      {
        ul: [
          [
            { b: "Plan data" },
            " (majors, courses, progress) is stored on your device. If you choose to sign in, your plan syncs to your own private row in our database (Supabase, US region), which only your account can read. ",
            "You can remove it with “Start over”, and deleting your account deletes every plan attached to it.",
          ],
          [
            { b: "Stored on your device" },
            ", all of it in local storage rather than cookies: your plan and its recent history, a backup taken when two devices disagree, your light/dark choice, whether you last used the canvas or the list, and — if you sign in — your session token. Nothing here is sent anywhere unless you turn on sync.",
          ],
          [
            { b: "Sign-in is optional" },
            " and uses Google or Microsoft. We receive your email address, to tell your account apart from anyone else's, and nothing else. Without it the app is entirely local.",
          ],
          [
            { b: "Your own AI assistant." },
            " LionsDegree publishes an MCP server that runs on your machine and reads a plan file you own. We operate no AI service and receive nothing from it. If you connect your own assistant, your plan is handled by whichever AI provider you chose, under their terms — that is a path between you and them, and we are not in it.",
          ],
          [
            { b: "No tracking:" },
            " no advertising, no analytics, no third-party scripts of any kind, no sale of data. The page loads nothing from any other host, which is enforced by our Content Security Policy rather than only promised here.",
          ],
          [
            { b: "Access or deletion:" },
            " email ",
            mail,
            ". Sync is off unless you turned it on, in which case your data lives in the database of whoever runs the instance you signed in to.",
          ],
        ],
      },
      { p: ["This service is intended for people 13 and older."] },
      { p: [{ i: `Last updated ${UPDATED}.` }, " Source code: ", repo, "."] },
    ],
  },
  {
    id: "terms",
    tab: "Terms",
    heading: "Terms of Use",
    title: "Terms of Use — LionsDegree",
    description:
      "LionsDegree is an independent, unofficial planning tool and is not affiliated with Penn State. Degree decisions must be confirmed with your adviser.",
    path: "/terms/",
    body: [
      {
        ul: [
          [
            { b: "Not official advising." },
            " LionsDegree is an independent planning tool and is not affiliated with, endorsed by, or operated by The Pennsylvania State University. Course data comes from public university bulletins and may be incomplete, stale, or wrong. Degree decisions must be confirmed with your academic adviser and official university systems.",
          ],
          [
            { b: "Course information belongs to Penn State." },
            " Course titles, requirements and descriptions are the University's, reproduced here to help you find them and linked back to the bulletin page they came from. They are quoted, never rewritten, and the bulletin is the authority wherever the two disagree.",
          ],
          [
            { b: "AI disclosure." },
            " If you connect your own AI assistant through our MCP server, its answers are generated by that model and it can be wrong. The planner gives it real catalog data, which makes it better grounded — it does not make it correct. Verify anything that matters against the bulletin or your adviser.",
          ],
          [
            { b: "No warranty." },
            " The service is provided “as is” without warranties of any kind. To the maximum extent permitted by law, we are not liable for academic, financial, or other consequences of relying on the app — including missed requirements, delayed graduation, or tuition impacts.",
          ],
          [
            { b: "Acceptable use." },
            " Don't abuse the service: no evading rate limits, and no attempting to reach anyone else's data.",
          ],
          [{ b: "Changes." }, " Features and these terms may change; continued use is acceptance."],
        ],
      },
      { p: [{ i: `Last updated ${UPDATED}.` }, " Questions: ", mail, "."] },
    ],
  },
  {
    id: "accessibility",
    tab: "Accessibility",
    heading: "Accessibility Statement",
    title: "Accessibility — LionsDegree",
    description: "LionsDegree aims to conform to WCAG 2.1 AA. The flowchart has a fully keyboard- and screen-reader-accessible list view.",
    body: [
      {
        p: [
          "LionsDegree aims to conform to WCAG 2.1 AA. The interactive flowchart has an equivalent ",
          { b: "list view" },
          " (toolbar → “List view”) that is fully keyboard- and screen-reader-accessible: every course, prerequisite status, and action available on the canvas is available there.",
        ],
      },
      {
        p: [
          "Known limitations we're working on: drag-and-drop on the canvas is pointer-only (use the list view's move controls instead), and some colour-coded statuses are supplemented by text labels in the list view rather than on the canvas cards.",
        ],
      },
      {
        p: [
          "If you hit a barrier, email ",
          mail,
          " or open an issue at ",
          repo,
          " — we treat accessibility reports as bugs to fix, not feedback to file.",
        ],
      },
      { p: [{ i: `Last updated ${UPDATED}.` }] },
    ],
  },
];

export const sectionById = (id: Section["id"]): Section => {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s) throw new Error(`no legal section "${id}"`);
  return s;
};
