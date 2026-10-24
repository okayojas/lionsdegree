/** The 3D journey is built from real courses, and this is what keeps it that
 * way.
 *
 * Hardcoded coordinates are a design choice; hardcoded course data is a
 * liability. A code that stops resolving, a title edited by hand, a
 * prerequisite claim that stops being true after a bulletin sync — each of
 * those puts a confident wrong statement in front of a student, which is the
 * one failure this project is built to avoid (iron rule 2).
 *
 * The proof-of-concept this was ported from wrote the AI subject as `A-I`
 * and five of thirteen nodes matched nothing in the catalog. That is exactly
 * the class of error this file exists to catch.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JOURNEY_NODES,
  JOURNEY_EDGES,
  JOURNEY_NOTES,
  type JourneyNote,
} from "../src/landing/journey-data.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = path.resolve(here, "..", "public", "catalog");

interface CatalogCourse {
  code: string;
  title: string;
  credits?: string;
  enforced?: string | null;
}

/** Every course in the latest shipped edition, keyed by code. */
let courses: Record<string, CatalogCourse> = {};
let edition = "";

beforeAll(() => {
  const editions = JSON.parse(fs.readFileSync(path.join(catalog, "editions.json"), "utf-8"));
  edition = editions.latest as string;
  const dir = path.join(catalog, edition, "courses");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    const list: CatalogCourse[] = Array.isArray(parsed) ? parsed : (parsed.courses ?? []);
    for (const c of list) if (c?.code && !courses[c.code]) courses[c.code] = c;
  }
  if (!Object.keys(courses).length) {
    throw new Error(`no courses read from ${dir} — run \`pnpm --filter web sync-catalog\``);
  }
});

describe("the journey's course data", () => {
  it("names thirteen stops ending at the terminus", () => {
    expect(JOURNEY_NODES).toHaveLength(13);
    expect(JOURNEY_NODES[JOURNEY_NODES.length - 1].code).toBe("AI 410");
  });

  it("every code resolves against the shipped catalog", () => {
    const missing = JOURNEY_NODES.filter((n) => !courses[n.code]).map((n) => n.code);
    expect(missing, `not in the ${edition} catalog`).toEqual([]);
  });

  it("every title is the catalog's, character for character", () => {
    // Not `toContain`, not case-insensitive. A paraphrased title is invented
    // course data wearing the catalog's clothes.
    const wrong = JOURNEY_NODES.filter((n) => courses[n.code] && courses[n.code].title !== n.title).map(
      (n) => `${n.code}: shipped ${JSON.stringify(courses[n.code].title)}, file says ${JSON.stringify(n.title)}`,
    );
    expect(wrong).toEqual([]);
  });

  it("names no course the catalog does not have", () => {
    // Guards the other direction from the title check: a note for a course
    // that was dropped from the bulletin.
    const missing = JOURNEY_NOTES.filter((r) => !courses[r.code]).map((r) => r.code);
    expect(missing).toEqual([]);
  });
});

describe("the journey's shape", () => {
  it("every edge points at a real node", () => {
    for (const { from, to } of JOURNEY_EDGES) {
      expect(JOURNEY_NODES[from], `edge from index ${from}`).toBeDefined();
      expect(JOURNEY_NODES[to], `edge to index ${to}`).toBeDefined();
      expect(from, "an edge from a node to itself").not.toBe(to);
    }
  });

  it("the camera path has enough stops to be a curve", () => {
    // CatmullRomCurve3 needs at least two points, and a journey through two
    // is a line. Below four it reads as a diagram, not a route.
    expect(JOURNEY_NODES.filter((n) => n.main).length).toBeGreaterThanOrEqual(4);
  });

  it("every node is reachable, so none floats unexplained", () => {
    const touched = new Set(JOURNEY_EDGES.flatMap((e) => [e.from, e.to]));
    const orphans = JOURNEY_NODES.map((n, i) => (touched.has(i) ? null : n.code)).filter(Boolean);
    expect(orphans, "nodes with no edge at all").toEqual([]);
  });
});

describe("the conflict, which is the point of the scene", () => {
  it("marks exactly one node", () => {
    expect(JOURNEY_NODES.filter((n) => n.conflict).map((n) => n.code)).toEqual(["EE 456"]);
  });

  it("is a claim the catalog actually supports", () => {
    // The scene tells a student that EE 456 gates AI 410. If a bulletin sync
    // ever makes that false, the page is lying in amber and this fails.
    const terminus = courses["AI 410"];
    expect(terminus, "AI 410 is not in the catalog").toBeTruthy();
    expect(
      terminus.enforced ?? "",
      "AI 410 no longer lists EE 456 as an enforced prerequisite",
    ).toMatch(/EE\s*456/);
  });

  it("says so in its field note", () => {
    const note = JOURNEY_NOTES.find((r) => r.code === "EE 456");
    expect(note, "the conflict node has no field note").toBeTruthy();
    expect(note!.kind).toMatch(/conflict/i);
    expect(note!.question).toMatch(/AI 410/);
  });
});

describe("the field notes republish no Bulletin prose", () => {
  // DECISIONS.md 5.1. The catalog deliberately ships keywords instead of
  // descriptions, and a landing page that pastes the description back in
  // undoes that decision in the most public place on the site.
  const hasNoDescription = (note: JourneyNote) => {
    for (const term of note.about) {
      expect(term.split(/\s+/).length, `"${term}" is a phrase, not a keyword`).toBe(1);
    }
  };

  it("carries topic terms, not sentences", () => {
    for (const note of JOURNEY_NOTES) hasNoDescription(note);
  });

  it("quotes the enforced string exactly where it quotes one at all", () => {
    for (const note of JOURNEY_NOTES) {
      if (note.requires === null) continue;
      expect(
        courses[note.code].enforced ?? "",
        `${note.code}'s requirement text does not match the catalog`,
      ).toBe(note.requires);
    }
  });

  it("states credits the catalog agrees with", () => {
    for (const note of JOURNEY_NOTES) {
      expect(note.credits, `${note.code} credits`).toBe(courses[note.code].credits);
    }
  });
});
