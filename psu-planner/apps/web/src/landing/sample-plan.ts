/** The sample Plan on the landing page.
 *
 * DATA, NOT TEXT TYPED INTO THE PAGE. The landing page draws one Plan: eight
 * Terms of six Courses. It is written here once, the build writes it into the
 * document as a list (vite.config.ts), and the scene that draws it as a field
 * of spheres reads the same list. A Course code typed into the markup by hand
 * is one nobody checks.
 *
 * WHERE IT COMES FROM. The core is the Bulletin's own suggested plan for the
 * Program named below. The Bulletin leaves general-education and elective
 * Slots open, and a sphere has to have a name on it, so those Slots are
 * filled here with real Courses chosen for the page. That is why the page
 * calls it a sample, and why it must never be read as anyone's requirements.
 * It is marketing content and does not enter the catalog dataset.
 *
 * CHECKED AGAINST THE EDITION. Every code below has to be a Course in the
 * latest Edition, or the build stops (scripts/sample-plan.mts). A Course
 * retired from the Bulletin would otherwise go on being advertised on the
 * front page.
 *
 * NO IMPORTS, and it has to stay that way: vite.config.ts loads this file
 * while it is still deciding how to resolve everything else.
 */

export interface SamplePlan {
  /** The Program's identifier in the catalog, so the Edition can be asked
   * whether it still has it. */
  program: string;
  /** What the page calls the Program. */
  title: string;
  /** In order, first fall to last spring. The position of a Course within
   * its Term is its lane: a sequence keeps one lane where it can (calculus
   * first, the programming core third), so reading one position across the
   * Terms is reading the order those Courses are taken in. */
  terms: readonly { name: string; courses: readonly string[] }[];
  /** Real Courses that are NOT in this Plan. The scene lets them fall with
   * everything else, and they are the ones that are not caught. The page
   * itself never lists them. A phone shows the first six. */
  others: readonly string[];
}

export const TERMS = 8;
export const COURSES_PER_TERM = 6;

export const SAMPLE_PLAN: SamplePlan = {
  program: "engineering-computer-science-bs",
  title: "Computer Science, B.S.",
  terms: [
    { name: "Fall 1", courses: ["MATH 140", "PSYCH 100", "CMPSC 131", "CMPSC 150N", "ENGL 15", "ENGR 100"] },
    { name: "Spring 1", courses: ["MATH 141", "PHYS 211", "CMPSC 132", "SOC 1", "MUSIC 4", "GEOG 30N"] },
    { name: "Fall 2", courses: ["MATH 230", "PHYS 212", "CMPSC 221", "MATH 220", "CAS 100A", "THEA 100"] },
    { name: "Spring 2", courses: ["ASTRO 5", "CMPEN 270", "CMPSC 222", "CMPSC 360", "PHIL 10", "KINES 77"] },
    { name: "Fall 3", courses: ["STAT 318", "CMPSC 315", "CMPSC 465", "CMPSC 320", "HIST 21", "ASIA 100"] },
    { name: "Spring 3", courses: ["STAT 319", "CMPSC 316", "CMPSC 461", "CMPSC 442", "ENGL 202C", "COMM 150N"] },
    { name: "Fall 4", courses: ["CMPSC 448", "CMPSC 464", "CMPSC 483W", "CMPSC 471", "CMPSC 431W", "NUTR 100"] },
    { name: "Spring 4", courses: ["CMPSC 455", "CMPSC 467", "CMPSC 410", "ARTH 100", "CMLIT 153", "EARTH 100"] },
  ],
  others: [
    "MATH 110", "SCM 200", "ACCTG 211", "SCM 301", "MIS 301", "FIN 413", "BA 411", "IB 303",
    "ECON 102", "ECON 104", "ECON 302", "FIN 301", "FIN 305W", "FIN 407", "FIN 405", "FIN 414",
    "PSU 6", "MGMT 301", "MKTG 301", "MIS 250", "FIN 408", "FIN 406", "FIN 410", "FIN 415",
    "ENGL 137H", "CAS 138T", "ECON 304", "HIST 20", "ENGL 202D", "BA 342", "BLAW 441", "MKTG 330",
    "SPAN 1", "SPAN 2", "SPAN 3", "SPAN 131", "BLAW 341", "RM 302", "ECON 451", "MGMT 326",
    "ART 20", "IST 110", "METEO 3", "KINES 61", "RLST 1", "BISC 3", "DANCE 100", "GEOSC 10",
  ],
};

/** What the latest Edition knows, as far as this file needs to ask. */
export interface EditionLookup {
  edition: string;
  hasCourse(code: string): boolean;
  hasProgram(id: string): boolean;
}

/** Everything wrong with a sample Plan, in words. Empty when it is sound.
 *
 * The shape is checked as well as the codes: the page promises eight Terms
 * of six, and the scene lays its rectangle out on that promise. */
export function samplePlanProblems(plan: SamplePlan, catalog: EditionLookup): string[] {
  const problems: string[] = [];
  if (!catalog.hasProgram(plan.program)) {
    problems.push(`the Program "${plan.program}" is not in the ${catalog.edition} Edition`);
  }
  if (plan.terms.length !== TERMS) problems.push(`${plan.terms.length} Terms, not ${TERMS}`);
  for (const term of plan.terms) {
    if (term.courses.length !== COURSES_PER_TERM) {
      problems.push(`${term.name} has ${term.courses.length} Courses, not ${COURSES_PER_TERM}`);
    }
  }

  const seen = new Set<string>();
  const listed: [where: string, code: string][] = [
    ...plan.terms.flatMap((term) => term.courses.map((code): [string, string] => [term.name, code])),
    ...plan.others.map((code): [string, string] => ["the other Courses", code]),
  ];
  for (const [where, code] of listed) {
    if (seen.has(code)) problems.push(`${code} is listed twice (again in ${where})`);
    seen.add(code);
    if (!catalog.hasCourse(code)) {
      problems.push(`${code} (${where}) is not a Course in the ${catalog.edition} Edition`);
    }
  }
  return problems;
}

/** Stops the build when the sample Plan names something the Edition does not
 * have. Throwing is the point: a script that calls this and is not caught
 * exits non-zero, and `npm run build` runs that script first. */
export function assertSamplePlan(plan: SamplePlan, catalog: EditionLookup): void {
  const problems = samplePlanProblems(plan, catalog);
  if (problems.length) {
    throw new Error(
      `The landing page's sample Plan does not match the ${catalog.edition} Edition:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nFix src/landing/sample-plan.ts. The page must not advertise a Course the Bulletin no longer has.`,
    );
  }
}

/** Where the build writes the list into the landing document. */
export const SAMPLE_PLAN_SLOT = "<!-- sample-plan -->";

/** The sample Plan as a list, grouped by Term.
 *
 * This is the Plan for anyone the scene does not reach: a visitor with
 * scripts off, a device with no WebGL, a student who asked for less motion,
 * a screen reader. The scene, where it runs, replaces it visually and nothing
 * else.
 *
 * A code is two spans with a space between, so it is set as the spheres set
 * it (subject over number) and still read, copied and found as "MATH 140".
 * Every third or so is the deeper tone; that is texture, decided here so it
 * does not change between builds, and it means nothing. */
export function samplePlanHtml(plan: SamplePlan): string {
  const course = (code: string, term: number, lane: number): string => {
    const cut = code.lastIndexOf(" ");
    const deep = (term * 5 + lane * 3) % 7 < 2 ? " is-deep" : "";
    return `<li class="course${deep}"><span>${code.slice(0, cut)}</span> <b>${code.slice(cut + 1)}</b></li>`;
  };
  const terms = plan.terms
    .map(
      (term, t) => `<li class="plan-term">
            <h3>${term.name}</h3>
            <ul>
              ${term.courses.map((code, lane) => course(code, t, lane)).join("\n              ")}
            </ul>
          </li>`,
    )
    .join("\n          ");
  // The caption is part of the Plan, not of the page around it: wherever
  // the list is printed, it says in the same breath that it is a sample.
  // (No full stop after the title: "B.S." brings its own.)
  return `<figure class="plan-figure" id="sample-plan">
        <ol class="plan-terms" aria-label="A sample plan for ${plan.title}: ${plan.terms.length} terms, in order">
          ${terms}
        </ol>
        <figcaption><b>Sample plan</b> · ${plan.title} The core is the Bulletin's suggested plan; where it leaves a choice open, a real course has been filled in for the picture. Yours will differ.</figcaption>
      </figure>`;
}
