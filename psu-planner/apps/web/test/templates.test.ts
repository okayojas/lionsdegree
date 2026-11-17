/** Templates as the web catalog publishes them: the index of which Programs
 * have one and where, and each Program's own file of them, Term by Term.
 *
 * The Sample plans page is a list made from the index (#67) and shows a
 * Program's Terms from its file (#68). So there are four ways for these to
 * be wrong that matter: a Program is listed that the Edition does not have
 * (a link to an error); a student is told a plan is for somewhere it is not;
 * a file says something the Bulletin's plan does not (a Course in a Slot, a
 * Course the Edition has never heard of); or a file carries more of the
 * Bulletin than a grid of codes and labels.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Plain JavaScript, because the sync script that calls it is.
import zlib from "node:zlib";
import { campusesOf, templateFile, templateIndex, writeTemplates } from "../scripts/templates.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = path.join(web, "public", "catalog");
const editions = (JSON.parse(fs.readFileSync(path.join(catalog, "editions.json"), "utf-8")) as { editions: string[] }).editions;

/** Every name a campus may go by in a published index. Written out here, not
 * imported from the generator: a campus the generator did not recognise comes
 * through as whatever the Bulletin wrote, and this list is what catches it. */
const KNOWN_CAMPUSES = [
  "University Park Campus",
  "Abington Campus",
  "Altoona Campus",
  "Beaver Campus",
  "Berks Campus",
  "Brandywine Campus",
  "DuBois Campus",
  "Erie Campus",
  "Fayette Campus",
  "Greater Allegheny Campus",
  "Harrisburg Campus",
  "Hazleton Campus",
  "Lehigh Valley Campus",
  "Mont Alto Campus",
  "New Kensington Campus",
  "Schuylkill Campus",
  "Scranton Campus",
  "Shenango Campus",
  "Wilkes-Barre Campus",
  "York Campus",
  "World Campus",
  "Commonwealth Campuses",
  "All campuses",
];

interface Entry {
  program: string;
  name: string;
  campuses: string[];
}
const published = (edition: string): Entry[] =>
  JSON.parse(fs.readFileSync(path.join(catalog, edition, "templates", "index.json"), "utf-8"));

describe("the campuses a suggested plan is for", () => {
  // The labels here are the Bulletin's, as it publishes them, except where
  // a test says it made one up.
  it("are the ones the Bulletin's label names after \"at\"", () => {
    expect(campusesOf("Accounting, B.S. at Abington Campus")).toEqual(["Abington Campus"]);
    // An option in front does not confuse it.
    expect(campusesOf("Digital Media Option: Arts Administration, B.A. at Lehigh Valley Campus")).toEqual(["Lehigh Valley Campus"]);
    expect(campusesOf("Software Engineering, B.S. at World Campus")).toEqual(["World Campus"]);
  });

  it("are each of them, where the label names several", () => {
    expect(campusesOf("Marketing, B.S. at Erie Campus and World Campus")).toEqual(["Erie Campus", "World Campus"]);
    expect(campusesOf("Biology, B.S. at University Park Campus and Commonwealth Campuses")).toEqual([
      "University Park Campus",
      "Commonwealth Campuses",
    ]);
    // "Campuses" said once, at the end, for all of them.
    expect(campusesOf("Second Degree in Nursing Option: Nursing, B.S.N. at Altoona, Erie, and Harrisburg Campuses")).toEqual([
      "Altoona Campus",
      "Erie Campus",
      "Harrisburg Campus",
    ]);
    expect(campusesOf("RN to BSN Option: Nursing, B.S.N. at University Park, Abington, Shenango, and World Campus Campuses")).toEqual([
      "University Park Campus",
      "Abington Campus",
      "Shenango Campus",
      "World Campus",
    ]);
    // Where a plan starts and where it ends are both where it is for.
    expect(
      campusesOf("Biochemistry Option: Biochemistry and Molecular Biology, B.S. Starting at Berks Campus and Ending at University Park Campus"),
    ).toEqual(["Berks Campus", "University Park Campus"]);
  });

  it("do not include a remark about which plan it is, or who it is for", () => {
    // Each of these was once shown to students as a campus of its own.
    expect(campusesOf("Psychology, B.A. at Erie Campus (3-Year Accelerated Plan)")).toEqual(["Erie Campus"]);
    expect(campusesOf("Mechanical Engineering, B.S. at University Park Campus (Last Names Starting with A-K)")).toEqual([
      "University Park Campus",
    ]);
    expect(campusesOf("Communication Sciences and Disorders, B.S. at Harrisburg Campus (Transfer Students)")).toEqual(["Harrisburg Campus"]);
    expect(
      campusesOf("Psychology, B.S. at New Kensington Campus with Behavioral Health and Counseling Psychology Certificate"),
    ).toEqual(["New Kensington Campus"]);
  });

  it("are not taken from inside a remark, where a campus is named for another reason", () => {
    // The last " at " in this one is inside the brackets. Cutting there gave
    // "their Commonwealth Campus)" as a place.
    expect(
      campusesOf(
        "Chemistry, B.S. at Commonwealth Campuses (For Change-of-Campus students who can take CHEM 213 at their Commonwealth Campus)",
      ),
    ).toEqual(["Commonwealth Campuses"]);
    // "Except Altoona" is not a plan at Altoona.
    expect(campusesOf("Agribusiness Management, B.S. at Commonwealth Campuses (except Altoona)")).toEqual(["Commonwealth Campuses"]);
    expect(campusesOf("Premedicine, B.S. for 2+2 Students Starting at a Commonwealth Campus")).toEqual(["Commonwealth Campuses"]);
  });

  it("read past the Bulletin's own slips of spelling", () => {
    // Both spellings are in the Bulletin; these two labels are cut down to
    // the part that matters.
    expect(campusesOf("Information Technology, B.S. at Hazelton Campus")).toEqual(["Hazleton Campus"]);
    expect(campusesOf("Information Technology, B.S. at hazleton Campus")).toEqual(["Hazleton Campus"]);
  });

  it("are none where the label names no place", () => {
    // A campus is never guessed at. Some plans in the Bulletin carry no label.
    expect(campusesOf("")).toEqual([]);
    expect(campusesOf("Political Science, B.S.")).toEqual([]);
    expect(campusesOf(undefined)).toEqual([]);
  });

  it("are the Bulletin's own words where it names a place this does not know", () => {
    // Not dropped, and not turned into something it is not. The check on the
    // published index is what then says a campus needs adding. (An invented
    // label: the Bulletin has no such plan today.)
    expect(campusesOf("Marine Science, B.S. at Wallops Island")).toEqual(["Wallops Island"]);
  });
});

describe("joining an Edition's Programs to the plans found for them", () => {
  const programs = [
    { slug: "physics-bs", name: "Physics, B.S.", campuses: [] },
    { slug: "behrend-accounting-bs", name: "Accounting, B.S. (Behrend)", campuses: ["Erie, The Behrend College"] },
    { slug: "astronomy-minor", name: "Astronomy Minor", campuses: [] },
  ];

  it("does not list a Template whose Program the Edition does not have", () => {
    // The page's one action opens the Program in the planner, and the planner
    // refuses a Program that is not in this index. A plan left over from a
    // Program the Bulletin has since dropped would be a link to an error.
    const index = templateIndex(programs, [
      { program: "physics-bs", label: "Physics, B.S. at University Park Campus" },
      { program: "alchemy-bs", label: "Alchemy, B.S. at University Park Campus" },
    ]);
    expect(index.map((e) => e.program)).toEqual(["physics-bs"]);
  });

  it("does not list a Program that has no Template", () => {
    const index = templateIndex(programs, [{ program: "physics-bs", label: "Physics, B.S. at University Park Campus" }]);
    expect(index.map((e) => e.program), "a minor with no suggested plan is on the list").not.toContain("astronomy-minor");
  });

  it("lists a Program once, with each campus its plans are for, once", () => {
    // One plan per campus, and often one per option at each campus.
    const index = templateIndex(programs, [
      { program: "physics-bs", label: "General Option: Physics, B.S. at University Park Campus" },
      { program: "physics-bs", label: "Medical Option: Physics, B.S. at University Park Campus" },
      { program: "physics-bs", label: "General Option: Physics, B.S. at Altoona Campus" },
      { program: "physics-bs", label: "General Option: Physics, B.S. at Altoona Campus (3-Year Accelerated Plan)" },
    ]);
    expect(index).toEqual([{ program: "physics-bs", name: "Physics, B.S.", campuses: ["University Park Campus", "Altoona Campus"] }]);
  });

  it("gives a plan with no place in its label the campus on the Program's record", () => {
    const index = templateIndex(programs, [
      { program: "behrend-accounting-bs", label: "" },
      { program: "physics-bs", label: "" },
    ]);
    expect(index).toEqual([
      // "Erie, The Behrend College" on the record is the Erie campus.
      { program: "behrend-accounting-bs", name: "Accounting, B.S. (Behrend)", campuses: ["Erie Campus"] },
      // No label and nothing on the record: nothing is said.
      { program: "physics-bs", name: "Physics, B.S.", campuses: [] },
    ]);
  });

  it("does so plan by plan, so a Program with one labelled plan keeps the campus of its other", () => {
    // Software Engineering at Behrend, as published: its first plan carries
    // no label and is Erie's; its second is labelled for World Campus. With
    // the record consulted only when NO plan was labelled, the page said
    // "World Campus" for a Program taught in Erie.
    const index = templateIndex(programs, [
      { program: "behrend-accounting-bs", label: "" },
      { program: "behrend-accounting-bs", label: "Accounting, B.S. at World Campus" },
    ]);
    expect(index[0].campuses).toEqual(["Erie Campus", "World Campus"]);
  });

  it("is in name order, which is how a student looks for theirs", () => {
    const index = templateIndex(programs, programs.map((p) => ({ program: p.slug, label: "" })));
    expect(index.map((e) => e.name)).toEqual(["Accounting, B.S. (Behrend)", "Astronomy Minor", "Physics, B.S."]);
  });
});

describe("a Program's Templates, as its file carries them", () => {
  /** A Program as the catalog records it, cut down to what matters here: two
   * plans, one of them with no Terms, and around them the things a Template
   * file must not pick up. */
  const program = {
    slug: "physics-bs",
    name: "Physics, B.S.",
    url: "https://bulletins.psu.edu/undergraduate/colleges/eberly-science/physics-bs/",
    requirementSections: [{ title: "Prescribed Courses", text: "Students must complete the following with a grade of C or better." }],
    suggestedPlans: [
      {
        campusLabel: "Physics, B.S. at University Park Campus",
        totalCredits: 120,
        footnotes: { "*": "Course requires a grade of C or better for the major" },
        semesters: [
          {
            year: 1,
            term: "Fall",
            label: "Year 1 Fall",
            credits: 14,
            entries: [
              { type: "course", code: "CMPSC 121", credits: 3, footnotes: ["*"], alternatives: [] },
              { type: "course", code: "ENGL 15", credits: 3, footnotes: [], alternatives: ["ENGL 30H", "ESL 15"] },
              { type: "genEd", label: "General Education Course (GN)", domain: "GN", credits: 4, footnotes: ["†"] },
              { type: "placeholder", label: "IST 140*# or CMPSC 121‡ (GQ) or Option Course #3", credits: 3, footnotes: [] },
              { type: "placeholder", label: "Elective (if needed)", credits: 0, footnotes: [] },
              { type: "genEd", label: "General Education Course", domain: null, credits: null, footnotes: [] },
              { type: "placeholder", label: "Enter the major before the end of this semester by Updating Academics in LionPATH.", credits: null, footnotes: [] },
              { type: "course", code: "LA 283", credits: 1, footnotes: [], alternatives: [], unverified: true },
              { type: "course", code: "BISC 004", credits: 3, footnotes: [], alternatives: [] },
            ],
          },
          {
            year: 1,
            term: "Spring",
            label: "Year 1 Spring",
            credits: 4,
            entries: [{ type: "course", code: "MATH 140", credits: 4, footnotes: ["*"], alternatives: [] }],
          },
        ],
      },
      { campusLabel: "Physics, B.S. at Altoona Campus", totalCredits: 120, footnotes: {}, semesters: [] },
    ],
  };
  /** The Courses this made-up Edition has. Not LA 283, and not ESL 15. */
  const courseCodes = new Set(["CMPSC 121", "ENGL 15", "ENGL 30H", "MATH 140", "BISC 4"]);

  it("are its plans that have Terms, each Term in order with its Courses and its Slots", () => {
    expect(templateFile(program, courseCodes)).toEqual({
      program: "physics-bs",
      bulletin: "https://bulletins.psu.edu/undergraduate/colleges/eberly-science/physics-bs/",
      templates: [
        {
          label: "Physics, B.S. at University Park Campus",
          credits: 120,
          terms: [
            {
              label: "Year 1 Fall",
              credits: 14,
              entries: [
                { course: "CMPSC 121", credits: 3 },
                // The Course the Bulletin offers in its place; and the one it
                // offers that this Edition does not have, kept apart.
                { course: "ENGL 15", credits: 3, or: ["ENGL 30H"], orUnlisted: ["ESL 15"] },
                // A Slot is its label. Nothing is put in it.
                { slot: "General Education Course (GN)", credits: 4 },
                // The Bulletin's label lists Courses itself: kept as it wrote
                // it, without the marks that point at its footnotes. The "#"
                // in "#3" is not one of those.
                { slot: "IST 140 or CMPSC 121 (GQ) or Option Course #3", credits: 3 },
                // Nought is the Bulletin's figure, and is kept.
                { slot: "Elective (if needed)", credits: 0 },
                // General Education with no credits given is still a Slot:
                // no credits, not nought.
                { slot: "General Education Course" },
                // Not a Course and not a choice, and its words are the
                // Bulletin's sentence: said to be there, not copied.
                { note: true },
                // Named by the plan, missing from the Edition: said, not
                // passed off as a Course.
                { unlisted: "LA 283", credits: 1 },
                // The same Course, written the catalog's way.
                { course: "BISC 4", credits: 3 },
              ],
            },
            { label: "Year 1 Spring", credits: 4, entries: [{ course: "MATH 140", credits: 4 }] },
          ],
        },
      ],
    });
  });

  it("carry none of the Bulletin's notes or remarks, and nothing else of the Program's record", () => {
    const text = JSON.stringify(templateFile(program, courseCodes));
    expect(text).not.toMatch(/grade of C|footnotes|requirementSections|Prescribed|unverified|domain|LionPATH/);
    // The footnote marks point at notes that are not published.
    expect(text).not.toMatch(/[*†‡]/);
  });

  it("link to the Bulletin only where the record's address is the Bulletin's", () => {
    // The page makes a link of this. Nothing but the Bulletin's own site is
    // ever published as one.
    for (const url of [undefined, "", "javascript:alert(1)", "http://bulletins.psu.edu/x", "https://bulletins.psu.edu.evil.example/x"]) {
      expect(templateFile({ ...program, url }, courseCodes), String(url)).not.toHaveProperty("bulletin");
    }
  });

  it("are nothing at all for a Program with no plan that has Terms", () => {
    expect(templateFile({ slug: "history-ba", suggestedPlans: [{ campusLabel: "History, B.A.", semesters: [] }] }, courseCodes)).toBeNull();
    expect(templateFile({ slug: "astronomy-minor" }, courseCodes)).toBeNull();
  });
});

describe("writing an Edition's Templates", () => {
  /** A small Edition on disk: two Programs in the index, and a third file
   * with a plan in it that the index does not name. */
  function smallEdition(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-edition-"));
    const term = { label: "Year 1 Fall", credits: 4, entries: [{ type: "course", code: "PHYS 211", credits: 4, alternatives: [] }] };
    const program = (slug: string, plans: { campusLabel: string; semesters: unknown[] }[]) => {
      fs.mkdirSync(path.join(dir, "programs", "majors"), { recursive: true });
      fs.writeFileSync(path.join(dir, "programs", "majors", `${slug}.json`), JSON.stringify({ slug, suggestedPlans: plans }));
    };
    fs.writeFileSync(
      path.join(dir, "programs_index.json"),
      JSON.stringify([
        { slug: "physics-bs", name: "Physics, B.S.", type: "major", campuses: [] },
        { slug: "history-ba", name: "History, B.A.", type: "major", campuses: [] },
      ]),
    );
    fs.writeFileSync(path.join(dir, "audit-index.json"), JSON.stringify({ courses: [{ code: "PHYS 211" }] }));
    program("physics-bs", [{ campusLabel: "Physics, B.S. at University Park Campus", semesters: [term] }]);
    // A plan with no Terms in it is not a plan anyone can be shown.
    program("history-ba", [{ campusLabel: "History, B.A. at University Park Campus", semesters: [] }]);
    program("alchemy-bs", [{ campusLabel: "Alchemy, B.S. at University Park Campus", semesters: [term] }]);
    return dir;
  }
  const written = (dir: string) => fs.readdirSync(path.join(dir, "templates")).sort();

  it("writes the index, and a file for each Program in it and for no other", () => {
    const dir = smallEdition();
    try {
      const made = writeTemplates(dir);
      expect(made).toMatchObject({ programCount: 1, templateCount: 1 });
      expect(JSON.parse(fs.readFileSync(path.join(dir, "templates", "index.json"), "utf-8"))).toEqual([
        { program: "physics-bs", name: "Physics, B.S.", campuses: ["University Park Campus"] },
      ]);
      // Not history-ba, which has no Template. Not alchemy-bs, which has one
      // and is not a Program of this Edition: its Template is not published.
      expect(written(dir)).toEqual(["index.json", "physics-bs.json"]);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "templates", "physics-bs.json"), "utf-8"))).toEqual({
        program: "physics-bs",
        templates: [
          {
            label: "Physics, B.S. at University Park Campus",
            terms: [{ label: "Year 1 Fall", credits: 4, entries: [{ course: "PHYS 211", credits: 4 }] }],
          },
        ],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves nothing behind from a Program the Bulletin has dropped", () => {
    const dir = smallEdition();
    try {
      fs.mkdirSync(path.join(dir, "templates"));
      fs.writeFileSync(path.join(dir, "templates", "phrenology-bs.json"), '{"program":"phrenology-bs","templates":[]}');
      writeTemplates(dir);
      expect(written(dir)).toEqual(["index.json", "physics-bs.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops, and says which file, where a Program file cannot be read", () => {
    // The page's claim is that it lists every Program with a plan. An index
    // that skipped a file it could not read would be one short and say
    // nothing.
    const dir = smallEdition();
    try {
      fs.writeFileSync(path.join(dir, "programs", "majors", "chemistry-bs.json"), '{ "slug": "chemistry-bs", "suggestedPl');
      expect(() => writeTemplates(dir)).toThrow(/chemistry-bs\.json is not a Program file that can be read/);
      expect(fs.existsSync(path.join(dir, "templates", "index.json")), "an index was written anyway").toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is done by the catalog sync, for the Edition it has just rebuilt", () => {
    // The sync rebuilds an Edition's directory from the pipeline's output.
    // Templates it did not write would be gone after the next one. Read from
    // the script's text, because running it needs the pipeline's output: a
    // live statement (not a comment), on the directory just rebuilt, after
    // the copy that would otherwise wipe it out.
    const sync = fs.readFileSync(path.join(web, "scripts", "sync-catalog.mjs"), "utf-8");
    expect(sync).toMatch(/^import \{ writeTemplates \} from "\.\/templates\.mjs";$/m);
    const call = /^\s*const templates = writeTemplates\(dst\);$/m.exec(sync);
    expect(call, "the sync no longer writes the Templates").toBeTruthy();
    expect(call!.index).toBeGreaterThan(sync.indexOf("fs.cpSync(src, dst"));
    expect(call!.index, "written outside the loop over Editions").toBeLessThan(sync.indexOf("// Every edition now published"));
  });
});

/** The largest Template file, compressed as it is served. Measured at 4.4 KB
 * (Information Technology, B.S.: 44 plans, 107 KB before compression); the
 * middle one is 0.7 KB. "One small file per Program" is what #60 asked for,
 * and this is the measurement plus a fifth (ADR 0002). */
const LARGEST_TEMPLATE_FILE_CEILING_KB = 5.2;

describe.each(editions)("the Templates published for %s", (edition) => {
  const dir = path.join(catalog, edition, "templates");
  const index = published(edition);
  const programs = JSON.parse(fs.readFileSync(path.join(catalog, edition, "programs_index.json"), "utf-8")) as {
    slug: string;
    name: string;
    type: string;
    hasPlans?: boolean;
  }[];

  type Published = Record<string, unknown>;
  const fileOf = (program: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, `${program}.json`), "utf-8")) as {
      program: string;
      templates: { label: string; credits?: number; terms: { label: string; credits?: number; entries: Published[] }[] }[];
    };
  /** Every line of every Term of every Template, with where it is. */
  const lines = () =>
    index.flatMap((listed) =>
      fileOf(listed.program).templates.flatMap((template) =>
        template.terms.flatMap((term) => term.entries.map((entry) => ({ program: listed.program, term: term.label, entry }))),
      ),
    );

  /** Every Course code the Edition has, read from its Course files and not
   * from the index of them the generator uses: a second account. */
  const courses = (() => {
    const codes = new Set<string>();
    for (const sub of ["courses", path.join("courses", "grad")]) {
      const from = path.join(catalog, edition, sub);
      if (!fs.existsSync(from)) continue;
      for (const file of fs.readdirSync(from).filter((f) => f.endsWith(".json"))) {
        const list = JSON.parse(fs.readFileSync(path.join(from, file), "utf-8")) as { code?: string }[];
        if (Array.isArray(list)) for (const course of list) if (course.code) codes.add(course.code);
      }
    }
    return codes;
  })();

  it("the index carries Program identifiers, names and campuses, and nothing else", () => {
    expect(index.length).toBeGreaterThan(300);
    for (const entry of index) {
      expect(Object.keys(entry).sort(), entry.program).toEqual(["campuses", "name", "program"]);
      expect(typeof entry.program).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(Array.isArray(entry.campuses), entry.program).toBe(true);
    }
  });

  it("the index names no campus that is not a campus", () => {
    // Every campus is one of Penn State's, by one name. This is also what
    // keeps the Bulletin's sentences out: a label the generator could not
    // read comes through as written, Course codes and all, and fails here.
    const strangers = index.flatMap((e) => e.campuses.filter((c) => !KNOWN_CAMPUSES.includes(c)).map((c) => `${e.program}: ${c}`));
    expect(strangers, "add the campus to CAMPUSES in scripts/templates.mjs, and here").toEqual([]);
    for (const entry of index) expect(new Set(entry.campuses).size, `${entry.program} repeats a campus`).toBe(entry.campuses.length);
  });

  it("the index says where, for nearly every Program", () => {
    // The Bulletin leaves a handful unlabelled. More than a handful with no
    // campus would be the generator failing to read the labels.
    const silent = index.filter((e) => e.campuses.length === 0);
    expect(silent.length, silent.map((e) => e.program).join(", ")).toBeLessThanOrEqual(5);
  });

  it("the index lists exactly the Programs the Edition says have a suggested plan", () => {
    // Two independent accounts of the same fact: the pipeline's own flag on
    // each Program, and this index's walk of the Program files.
    const flagged = programs.filter((p) => p.hasPlans).map((p) => p.slug).sort();
    expect(index.map((e) => e.program).sort()).toEqual(flagged);
    const names = new Map(programs.map((p) => [p.slug, p.name]));
    for (const entry of index) expect(entry.name).toBe(names.get(entry.program));
  });

  it("there is a file for every Program in the index, and for no other", () => {
    // A file with no entry in the index is a Template published for a
    // Program the Edition does not list.
    expect(fs.readdirSync(dir).sort()).toEqual(["index.json", ...index.map((e) => `${e.program}.json`)].sort());
    for (const listed of index) expect(fileOf(listed.program).program).toBe(listed.program);
  });

  it("a file carries Course codes, credits and the Bulletin's labels, and nothing else", () => {
    const kinds = new Map<string, number>();
    for (const listed of index) {
      const file = fileOf(listed.program) as ReturnType<typeof fileOf> & { bulletin?: string };
      expect(Object.keys(file).filter((k) => k !== "bulletin").sort(), listed.program).toEqual(["program", "templates"]);
      // The one address in a file is the Program's page in the Bulletin.
      if (file.bulletin !== undefined) expect(file.bulletin, listed.program).toMatch(/^https:\/\/bulletins\.psu\.edu\/[a-z0-9/-]+$/);
      expect(file.templates.length, `${listed.program} has a file and no Template in it`).toBeGreaterThan(0);
      for (const template of file.templates) {
        expect(["label", "terms"], listed.program).toEqual(Object.keys(template).filter((k) => k !== "credits").sort());
        expect(template.terms.length, `${listed.program} has a Template with no Terms`).toBeGreaterThan(0);
        for (const term of template.terms) {
          expect(["entries", "label"], listed.program).toEqual(Object.keys(term).filter((k) => k !== "credits").sort());
          expect(term.label, listed.program).toMatch(/^Year \d (Fall|Spring|Summer)$/);
        }
      }
    }
    for (const { program, entry } of lines()) {
      const kind = Object.keys(entry).filter((k) => k !== "credits").sort().join("+");
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if ("credits" in entry) expect(typeof entry.credits, program).toBe("number");
      // A note is that there is one. It has no words and no credits.
      if ("note" in entry) expect(entry, program).toEqual({ note: true });
    }
    // Every line is one of these shapes. A Slot is only ever its label.
    const allowed = ["course", "course+or", "course+orUnlisted", "course+or+orUnlisted", "unlisted", "or+unlisted", "orUnlisted+unlisted", "or+orUnlisted+unlisted", "slot", "note"];
    expect([...kinds.keys()].filter((kind) => !allowed.includes(kind))).toEqual([]);
    expect(kinds.get("slot") ?? 0).toBeGreaterThan(10_000);
    expect(kinds.get("course") ?? 0).toBeGreaterThan(10_000);
  });

  it("every Course a Template names is a Course of this Edition", () => {
    const strangers: string[] = [];
    const wronglyUnlisted: string[] = [];
    const unlisted = new Set<string>();
    for (const { program, term, entry } of lines()) {
      const named = [entry.course, ...((entry.or as string[] | undefined) ?? [])].filter((c): c is string => typeof c === "string");
      for (const code of named) if (!courses.has(code)) strangers.push(`${program}, ${term}: ${code}`);
      // And the other way: a code is only flagged when it really is missing,
      // however the plan happens to write its number.
      const flagged = [entry.unlisted, ...((entry.orUnlisted as string[] | undefined) ?? [])].filter((c): c is string => typeof c === "string");
      for (const code of flagged) {
        unlisted.add(code);
        if (courses.has(code) || courses.has(code.replace(/ 0+(?=\d)/, " "))) wronglyUnlisted.push(`${program}, ${term}: ${code}`);
      }
    }
    expect(strangers, "named as a Course, and the Edition has no such Course").toEqual([]);
    expect(wronglyUnlisted, "flagged as missing from the Edition, which has it").toEqual([]);
    // The escape hatch stays small. 32 codes are flagged today (LA 283, IST
    // 302, SRA 221...). Many more would mean the Edition's Courses were not
    // read, and every plan on the page was full of "not in this catalog".
    expect(unlisted.size, [...unlisted].sort().join(", ")).toBeLessThanOrEqual(39);
  });

  it("no file carries a Course's description", () => {
    // What the catalog publishes of a Course's description is its opening
    // sentence, in summaries/. None of those is in a Template file, whole or
    // inside a label; and nothing in one is long enough to be a paragraph.
    const sentences = new Set<string>();
    const from = path.join(catalog, edition, "summaries");
    for (const file of fs.readdirSync(from).filter((f) => f.endsWith(".json"))) {
      for (const sentence of Object.values(JSON.parse(fs.readFileSync(path.join(from, file), "utf-8")) as Record<string, string>)) {
        if (typeof sentence === "string" && sentence.length >= 40) sentences.add(sentence);
      }
    }
    expect(sentences.size, "no summaries were read, so this would check nothing").toBeGreaterThan(5_000);

    const said = new Set<string>();
    for (const listed of index) for (const template of fileOf(listed.program).templates) said.add(template.label);
    for (const { entry } of lines()) if (typeof entry.slot === "string") said.add(entry.slot);
    const long = [...said].filter((text) => text.length >= 40);
    const prose = long.filter((text) => sentences.has(text) || [...sentences].some((sentence) => text.includes(sentence)));
    expect(prose).toEqual([]);
    expect(Math.max(...[...said].map((text) => text.length)), "a label as long as a paragraph").toBeLessThan(200);
  });

  it("no Slot's label is one of the Bulletin's remarks, or carries its footnote marks", () => {
    const labels = [...new Set(lines().flatMap(({ entry }) => (typeof entry.slot === "string" ? [entry.slot] : [])))];
    // A sentence, an instruction with an address in it, a line that leads
    // into the next: these are remarks, and are published as notes.
    expect(labels.filter((label) => /https?:|www\.|[.:]\s*$/.test(label)), "a remark was published as a Slot").toEqual([]);
    // "*", "†", "‡" and a "#" that is not in front of a number point at
    // footnotes that are not published.
    expect(labels.filter((label) => /[*†‡]|#(?!\d)/.test(label)), "a footnote mark is left in a label").toEqual([]);
    expect(labels.filter((label) => label.trim() !== label || label === ""), "a label is empty or padded").toEqual([]);
    // And the notes are a handful, not a way for Slots to go missing: 33
    // lines in the latest Edition, of about 43,000.
    const notes = lines().filter(({ entry }) => "note" in entry).length;
    expect(notes).toBeGreaterThan(0);
    expect(notes).toBeLessThanOrEqual(41);
  });

  it("says what the Program's own record says: the same Terms, and a Slot for every choice left open", () => {
    // Against the catalog's own Program files. Nothing is added, nothing is
    // dropped, and no Slot has had a Course put in it. The rules for what a
    // line becomes are written out again here, not borrowed from the
    // generator.
    const directory: Record<string, string> = { major: "majors", minor: "minors", certificate: "certificates" };
    const kindOf = new Map(programs.map((p) => [p.slug, directory[p.type]]));
    const unmarked = (label: string) => label.replace(/[*†‡]/g, "").replace(/#(?!\d)/g, "").replace(/\s+/g, " ").replace(/\s+([,;)])/g, "$1").trim();
    let slots = 0;
    for (const listed of index) {
      const record = JSON.parse(
        fs.readFileSync(path.join(catalog, edition, "programs", kindOf.get(listed.program)!, `${listed.program}.json`), "utf-8"),
      ) as {
        suggestedPlans: {
          campusLabel: string;
          semesters: { label: string; entries: { type: string; code?: string; label?: string; credits: number | null }[] }[];
        }[];
      };
      const plans = record.suggestedPlans.filter((plan) => plan.semesters.length > 0);
      const file = fileOf(listed.program);
      expect(file.templates.map((t) => t.label), listed.program).toEqual(plans.map((plan) => plan.campusLabel));
      file.templates.forEach((template, at) => {
        expect(template.terms.map((t) => t.label), listed.program).toEqual(plans[at].semesters.map((s) => s.label));
        template.terms.forEach((term, termAt) => {
          const source = plans[at].semesters[termAt].entries;
          const where = `${listed.program}, ${term.label}`;
          expect(term.entries, where).toHaveLength(source.length);
          source.forEach((from, line) => {
            const published = term.entries[line];
            if (from.type === "course") {
              // The record's code, flagged or not; or the same code with its
              // number written plainly.
              expect([from.code, from.code!.replace(/ 0+(?=\d)/, " ")], where).toContain(published.course ?? published.unlisted);
              return;
            }
            if (from.type !== "genEd" && typeof from.credits !== "number") {
              expect(published, `${where}: "${from.label}" has no credits and is not General Education`).toEqual({ note: true });
              return;
            }
            slots++;
            // The label and nothing but: no Course beside it.
            expect(Object.keys(published).filter((k) => k !== "credits"), where).toEqual(["slot"]);
            expect(published.slot, where).toBe(unmarked(from.label!));
            if (typeof from.credits === "number") expect(published.credits, where).toBe(from.credits);
          });
        });
      });
    }
    expect(slots).toBeGreaterThan(10_000);
  });

  it("each file is small enough to be fetched for one look at one Program", () => {
    const largest = Math.max(...index.map((e) => zlib.gzipSync(fs.readFileSync(path.join(dir, `${e.program}.json`))).length)) / 1024;
    expect(largest, `the largest Template file is ${largest.toFixed(1)} KB compressed`).toBeLessThan(LARGEST_TEMPLATE_FILE_CEILING_KB);
  });

  it("are what the generator writes today", () => {
    // Committed with the catalog. If this fails the files are stale: run
    // `node scripts/templates.mjs`.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-templates-"));
    try {
      writeTemplates(path.join(catalog, edition), fresh);
      expect(fs.readdirSync(fresh).sort()).toEqual(fs.readdirSync(dir).sort());
      const stale = fs.readdirSync(fresh).filter((file) => fs.readFileSync(path.join(fresh, file), "utf-8") !== fs.readFileSync(path.join(dir, file), "utf-8"));
      expect(stale).toEqual([]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("the latest Edition's index, on the Programs that used to be wrong", () => {
  const latest = (JSON.parse(fs.readFileSync(path.join(catalog, "editions.json"), "utf-8")) as { latest: string }).latest;
  const campuses = (program: string) => published(latest).find((e) => e.program === program)?.campuses;

  it("puts Software Engineering at Behrend in Erie, as well as online", () => {
    expect(campuses("behrend-software-engineering-bs")).toEqual(["Erie Campus", "World Campus"]);
  });

  it("does not give Chemistry a campus out of the middle of a sentence", () => {
    expect(campuses("eberly-science-chemistry-bs")).toEqual(["University Park Campus", "Commonwealth Campuses"]);
  });

  it("lists Erie once for a Program with an ordinary plan and an accelerated one", () => {
    expect(campuses("behrend-psychology-ba")).toEqual(["Erie Campus"]);
  });
});
