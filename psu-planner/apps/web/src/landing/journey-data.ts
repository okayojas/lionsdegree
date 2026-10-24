/** The thirteen courses the landing page's 3D journey travels.
 *
 * A real chain out of the 2026-2027 bulletin, ending at AI 410, and the whole
 * reason the scene exists is the amber node: EE 456 is an enforced
 * prerequisite of AI 410, and in the plan this was built from the two sit in
 * the same term. The scene is a picture of the engine catching that.
 *
 * CODES AND TITLES ARE VERBATIM from `public/catalog/2026-2027/courses/`, and
 * `test/journey-data.test.ts` re-checks every one of them against the shipped
 * catalog so this file cannot drift into fiction. The proof-of-concept wrote
 * the AI subject as `A-I`, which is how the Bulletin spells it inside
 * prerequisite PROSE but not how it codes the courses themselves — those are
 * `AI 100`, `AI 410`. Using the prose spelling meant five of thirteen nodes
 * matched nothing.
 *
 * NO COURSE DESCRIPTIONS. DECISIONS.md 5.1: the Bulletin's description prose
 * is Penn State's writing and is not republished here — that decision is the
 * reason the catalog ships extracted keywords at all. Everything a field note
 * shows is either a fact (a title, a credit count, which course requires
 * which) or something we derived ourselves, plus a link to the real page.
 */

export interface JourneyNode {
  /** Catalog code, e.g. `AI 410`. Must resolve in the shipped catalog. */
  code: string;
  /** Catalog title, verbatim. */
  title: string;
  pos: [number, number, number];
  /** On the camera path. The spine of the chain rather than a side branch. */
  main: boolean;
  /** Prerequisite violation in the source plan. Renders amber. */
  conflict?: boolean;
}

export interface JourneyEdge {
  from: number;
  to: number;
}

/** What a field note says about a stop.
 *
 * `requires` is the Bulletin's own enforced-prerequisite string. That is a
 * statement of a requirement, not descriptive prose, and the planner already
 * shows it on every course card — so it carries no exposure the app does not
 * already have. `about` holds the keywords the pipeline extracted, which is
 * what this project ships INSTEAD of a description. */
export interface JourneyNote {
  code: string;
  /** Why this stop is worth stopping at. Ours, not the Bulletin's. */
  kind: string;
  credits: string;
  /** Verbatim `enforced` string from the catalog; null where none is listed. */
  requires: string | null;
  /** Extracted topic terms — never a description. */
  about: string[];
  /** What the student should actually do with this. Ours. */
  question: string;
}

export const JOURNEY_NODES: JourneyNode[] = [
  { code: "MATH 141", title: "Calculus with Analytic Geometry II", pos: [0, 0, 0], main: true },
  { code: "PHYS 214", title: "General Physics: Wave Motion and Quantum Physics", pos: [14, 3, -26], main: true },
  { code: "ESC 312", title: "Engineering Applications of Wave, Particle, and Ensemble Concepts", pos: [-6, 7, -54], main: true },
  { code: "ESC 419", title: "Electronic Properties and Applications of Materials", pos: [-28, 10, -70], main: false },
  { code: "CMPSC 360", title: "Discrete Mathematics for Computer Science", pos: [18, 0, -84], main: true },
  { code: "STAT 401", title: "Experimental Methods", pos: [40, -4, -98], main: false },
  { code: "AI 100", title: "Artificial Intelligence: Automated Thinking to Augment Human Intellect", pos: [4, 6, -114], main: true },
  { code: "AI 305", title: "Algorithmic Foundations for Artificial Intelligence", pos: [-26, -2, -126], main: false },
  { code: "AI 370", title: "Problem Formulation and Automated Problem Solving", pos: [16, 9, -146], main: true },
  { code: "CMPSC 448", title: "Machine Learning and Algorithmic AI", pos: [44, 2, -162], main: false },
  { code: "AI 341W", title: "Responsible Artificial Intelligence", pos: [-4, 12, -178], main: true },
  { code: "EE 456", title: "Introduction to Neural Networks", pos: [-34, 4, -192], main: false, conflict: true },
  { code: "AI 410", title: "AI Systems and Tools", pos: [12, 16, -212], main: true },
];

export const JOURNEY_EDGES: JourneyEdge[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 2, to: 3 },
  { from: 2, to: 4 },
  { from: 4, to: 7 },
  { from: 4, to: 8 },
  { from: 5, to: 7 },
  { from: 5, to: 8 },
  { from: 6, to: 8 },
  { from: 6, to: 10 },
  { from: 8, to: 9 },
  { from: 8, to: 10 },
  { from: 9, to: 12 },
  { from: 10, to: 12 },
  { from: 11, to: 12 },
];

/** The stops that carry a field note, in the order the dialog walks them:
 * the destination first, then the thing standing in its way. */
export const JOURNEY_NOTES: JourneyNote[] = [
  {
    code: "AI 410",
    kind: "Terminus",
    credits: "3 Credits",
    requires: "(CMPSC 448 or DS 310) and A-I 341W and EE 456",
    about: ["deployment", "hardware", "machine", "scalable"],
    question: "Everything upstream has to resolve before this term. Does it?",
  },
  {
    code: "EE 456",
    kind: "Conflict — scheduled too late",
    credits: "3 Credits",
    requires: null,
    about: ["neural", "networks"],
    // The claim the whole scene is built to make, and it is checked in the
    // test: AI 410's enforced string really does name EE 456.
    question:
      "The Bulletin makes this an enforced prerequisite of AI 410, and the plan puts both in the same term. Move this earlier, or push AI 410 later?",
  },
  {
    code: "AI 341W",
    kind: "Writing intensive",
    credits: "3 Credits",
    requires: "A-I 100 Enforced Concurrent at Enrollment: A-I 370 and (DS 310 or CMPSC 448 or CMPSC 445)",
    about: ["fairness", "accountability", "privacy", "writing"],
    question: "It clears the W requirement too. Does double-counting free a slot elsewhere?",
  },
  {
    code: "AI 370",
    kind: "Branch point",
    credits: "3 Credits",
    requires:
      "A-I 100 and CMPSC 132 and (STAT 200 or DS 200) and (CMPSC 360 or Math 311W) Enforced Concurrent at Enrollment: (DS 305 or CMPSC 465 or CMPSC 462) and STAT 401",
    about: ["search", "constraint", "satisfaction", "heuristic"],
    question: "AI 100 sits in the same term in the source plan. That is a second conflict.",
  },
];

/** Where a reader goes for the text this page deliberately does not reprint. */
export const BULLETIN_URL = "https://bulletins.psu.edu/university-course-descriptions/undergraduate/";
