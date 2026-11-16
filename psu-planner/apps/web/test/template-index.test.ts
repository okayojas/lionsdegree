/** The Template index: which Programs publish a suggested plan, and where.
 *
 * The Sample plans page (#67) is a list of these and nothing more, and every
 * entry is a link into the planner. So the index has three ways to be wrong
 * that matter: it lists a Program the Edition does not have (a link to an
 * error), it tells a student a plan is for somewhere it is not, or it carries
 * more of the Bulletin than a list needs to.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Plain JavaScript, because the sync script that calls it is.
import { campusesOf, templateIndex, writeTemplateIndex } from "../scripts/template-index.mjs";

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

describe("writing the index for an Edition", () => {
  /** A small Edition on disk: two Programs in the index, and a third file
   * with a plan in it that the index does not name. */
  function smallEdition(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-edition-"));
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
    program("physics-bs", [{ campusLabel: "Physics, B.S. at University Park Campus", semesters: [{}] }]);
    // A plan with no Terms in it is not a plan anyone can be shown.
    program("history-ba", [{ campusLabel: "History, B.A. at University Park Campus", semesters: [] }]);
    program("alchemy-bs", [{ campusLabel: "Alchemy, B.S. at University Park Campus", semesters: [{}] }]);
    return dir;
  }

  it("reads the Program files, and leaves out a plan whose Program is not in the Edition's index", () => {
    const dir = smallEdition();
    try {
      const made = writeTemplateIndex(dir);
      expect(made).toMatchObject({ programCount: 1, templateCount: 2 });
      expect(JSON.parse(fs.readFileSync(path.join(dir, "templates", "index.json"), "utf-8"))).toEqual([
        { program: "physics-bs", name: "Physics, B.S.", campuses: ["University Park Campus"] },
      ]);
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
      expect(() => writeTemplateIndex(dir)).toThrow(/chemistry-bs\.json is not a Program file that can be read/);
      expect(fs.existsSync(path.join(dir, "templates", "index.json")), "an index was written anyway").toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is done by the catalog sync, for the Edition it has just rebuilt", () => {
    // The sync rebuilds an Edition's directory from the pipeline's output. An
    // index it did not write would be gone after the next one. Read from the
    // script's text, because running it needs the pipeline's output: a live
    // statement (not a comment), on the directory just rebuilt, after the
    // copy that would otherwise wipe it out.
    const sync = fs.readFileSync(path.join(web, "scripts", "sync-catalog.mjs"), "utf-8");
    expect(sync).toMatch(/^import \{ writeTemplateIndex \} from "\.\/template-index\.mjs";$/m);
    const call = /^\s*const templates = writeTemplateIndex\(dst\);$/m.exec(sync);
    expect(call, "the sync no longer writes the Template index").toBeTruthy();
    expect(call!.index).toBeGreaterThan(sync.indexOf("fs.cpSync(src, dst"));
    expect(call!.index, "written outside the loop over Editions").toBeLessThan(sync.indexOf("// Every edition now published"));
  });
});

describe.each(editions)("the index published for %s", (edition) => {
  const index = published(edition);
  const programs = JSON.parse(fs.readFileSync(path.join(catalog, edition, "programs_index.json"), "utf-8")) as {
    slug: string;
    name: string;
    hasPlans?: boolean;
  }[];

  it("carries Program identifiers, names and campuses, and nothing else", () => {
    expect(index.length).toBeGreaterThan(300);
    for (const entry of index) {
      expect(Object.keys(entry).sort(), entry.program).toEqual(["campuses", "name", "program"]);
      expect(typeof entry.program).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(Array.isArray(entry.campuses), entry.program).toBe(true);
    }
  });

  it("names no campus that is not a campus", () => {
    // Every campus is one of Penn State's, by one name. This is also what
    // keeps the Bulletin's sentences out: a label the generator could not
    // read comes through as written, Course codes and all, and fails here.
    const strangers = index.flatMap((e) => e.campuses.filter((c) => !KNOWN_CAMPUSES.includes(c)).map((c) => `${e.program}: ${c}`));
    expect(strangers, "add the campus to CAMPUSES in scripts/template-index.mjs, and here").toEqual([]);
    for (const entry of index) expect(new Set(entry.campuses).size, `${entry.program} repeats a campus`).toBe(entry.campuses.length);
  });

  it("says where, for nearly every Program", () => {
    // The Bulletin leaves a handful unlabelled. More than a handful with no
    // campus would be the generator failing to read the labels.
    const silent = index.filter((e) => e.campuses.length === 0);
    expect(silent.length, silent.map((e) => e.program).join(", ")).toBeLessThanOrEqual(5);
  });

  it("lists exactly the Programs the Edition says have a suggested plan", () => {
    // Two independent accounts of the same fact: the pipeline's own flag on
    // each Program, and this index's walk of the Program files.
    const flagged = programs.filter((p) => p.hasPlans).map((p) => p.slug).sort();
    expect(index.map((e) => e.program).sort()).toEqual(flagged);
    const names = new Map(programs.map((p) => [p.slug, p.name]));
    for (const entry of index) expect(entry.name).toBe(names.get(entry.program));
  });

  it("is what the generator writes today", () => {
    // Committed with the catalog. If this fails the file is stale: run
    // `node scripts/template-index.mjs`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-index-"));
    try {
      fs.cpSync(path.join(catalog, edition, "programs_index.json"), path.join(dir, "programs_index.json"));
      fs.cpSync(path.join(catalog, edition, "programs"), path.join(dir, "programs"), { recursive: true });
      writeTemplateIndex(dir);
      expect(fs.readFileSync(path.join(dir, "templates", "index.json"), "utf-8")).toBe(
        fs.readFileSync(path.join(catalog, edition, "templates", "index.json"), "utf-8"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
