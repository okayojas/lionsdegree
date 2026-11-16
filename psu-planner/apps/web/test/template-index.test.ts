/** The Template index: which Programs publish a suggested plan, and where.
 *
 * The Sample plans page (#67) is a list of these and nothing more, and every
 * entry is a link into the planner. So the index has two ways to be wrong
 * that matter: it lists a Program the Edition does not have (a link to an
 * error), or it carries more of the Bulletin than a list needs to.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Plain JavaScript, because the sync script that calls it is.
import { campusOf, templateIndex, writeTemplateIndex } from "../scripts/template-index.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = path.join(web, "public", "catalog");
const editions = (JSON.parse(fs.readFileSync(path.join(catalog, "editions.json"), "utf-8")) as { editions: string[] }).editions;

interface Entry {
  program: string;
  name: string;
  campuses: string[];
}
const published = (edition: string): Entry[] =>
  JSON.parse(fs.readFileSync(path.join(catalog, edition, "templates", "index.json"), "utf-8"));

describe("the campus a suggested plan is for", () => {
  it("is what follows the last \"at\" in the Bulletin's label, as the Bulletin wrote it", () => {
    expect(campusOf("Accounting, B.S. at Abington Campus")).toBe("Abington Campus");
    // An option in front does not confuse it...
    expect(campusOf("Digital Media Option: Arts Administration, B.A. at Lehigh Valley Campus")).toBe("Lehigh Valley Campus");
    // ...and what the Bulletin says is not tidied or split.
    expect(campusOf("Marketing, B.S. at Erie Campus and World Campus")).toBe("Erie Campus and World Campus");
    expect(campusOf("Computer Science, B.S. at University Park Campus (Last Names Starting with A-K)")).toBe(
      "University Park Campus (Last Names Starting with A-K)",
    );
  });

  it("is nothing where the label names none", () => {
    // A campus is never guessed at. A few plans in the Bulletin carry no label.
    expect(campusOf("")).toBeNull();
    expect(campusOf("Political Science, B.S.")).toBeNull();
    expect(campusOf(undefined)).toBeNull();
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
    ]);
    expect(index).toEqual([{ program: "physics-bs", name: "Physics, B.S.", campuses: ["University Park Campus", "Altoona Campus"] }]);
  });

  it("falls back to the Program's own campus where no plan names one, and to none where neither does", () => {
    const index = templateIndex(programs, [
      { program: "behrend-accounting-bs", label: "" },
      { program: "physics-bs", label: "" },
    ]);
    expect(index).toEqual([
      { program: "behrend-accounting-bs", name: "Accounting, B.S. (Behrend)", campuses: ["Erie, The Behrend College"] },
      { program: "physics-bs", name: "Physics, B.S.", campuses: [] },
    ]);
  });

  it("is in name order, which is how a student looks for theirs", () => {
    const index = templateIndex(programs, programs.map((p) => ({ program: p.slug, label: "" })));
    expect(index.map((e) => e.name)).toEqual(["Accounting, B.S. (Behrend)", "Astronomy Minor", "Physics, B.S."]);
  });
});

describe("writing the index for an Edition", () => {
  it("reads the Program files, and leaves out a plan whose Program is not in the Edition's index", () => {
    // A small Edition on disk: two Programs in the index, and a third file
    // with a plan in it that the index does not name.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-edition-"));
    try {
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

      const made = writeTemplateIndex(dir);
      expect(made).toMatchObject({ programs: 1, plans: 2, unreadable: 0 });
      expect(JSON.parse(fs.readFileSync(path.join(dir, "templates", "index.json"), "utf-8"))).toEqual([
        { program: "physics-bs", name: "Physics, B.S.", campuses: ["University Park Campus"] },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is done by the catalog sync, for every Edition it syncs", () => {
    // The sync rebuilds an Edition's directory from the pipeline's output. An
    // index it did not write would be gone after the next one.
    const sync = fs.readFileSync(path.join(web, "scripts", "sync-catalog.mjs"), "utf-8");
    expect(sync).toMatch(/import \{ writeTemplateIndex \} from "\.\/template-index\.mjs"/);
    expect(sync).toMatch(/writeTemplateIndex\(dst\)/);
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
      expect(Array.isArray(entry.campuses) && entry.campuses.every((c) => typeof c === "string"), entry.program).toBe(true);
    }
    // No Course code and no sentence of the Bulletin's has got in by way of
    // a "campus": the longest thing here is a list of campus names.
    const text = JSON.stringify(index);
    expect(text).not.toMatch(/\b[A-Z]{2,5} \d{1,3}[A-Z]?\b/);
    expect(Math.max(...index.flatMap((e) => e.campuses).map((c) => c.length))).toBeLessThan(200);
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
