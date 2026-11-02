/** Reading a Program the student has not declared.
 *
 * The question is asked while DECIDING: "what would a math minor
 * actually need?". Everything here is about what a student is told when
 * they ask about a credential that is not theirs — including the two
 * answers that would be worse than silence, which are "that program does
 * not exist" when it exists at another campus or in another Edition, and
 * "this requirement has nothing in it" when we simply could not read it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool, listTools, loadContext, type ToolContext } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const planPath = path.join(here, "fixtures", "plan.json");

/** A minor the fixture student is not in. Theirs is an engineering B.S. */
const MATH_MINOR = "eberly-science-mathematics-minor";
/** Offered at Abington and nowhere else. */
const ABINGTON_ONLY = "abington-accounting-bs";

interface Requirement {
  requirement: string;
  credits: number | null;
  courses?: string[];
  what_counts?: string;
  bulletin_wording?: string;
  status?: string;
}
interface Answer {
  slug?: string;
  name?: string;
  type?: string;
  edition?: string;
  offered_at?: string[] | null;
  in_your_plan?: boolean;
  total_credits?: number | null;
  sections?: { heading: string; credits_required: number | null; requirements: Requirement[] }[];
  note?: string;
  status?: string;
  nothing_read?: string;
  error?: string;
  editions_this_connector_carries?: string[];
  did_you_mean?: { slug: string; name: string }[];
}

let ctx: ToolContext;
beforeAll(async () => {
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const ask = (slug: unknown) =>
  executeTool("get_program_requirements", { slug }, ctx) as Promise<Answer>;

/** Every requirement in an answer, flattened — most properties here are
 * about requirements rather than about sections. */
const everyRequirement = (a: Answer): Requirement[] => (a.sections ?? []).flatMap((s) => s.requirements);

describe("asking what a program requires before declaring it", () => {
  it("answers for a program the student is not in", async () => {
    // THE POINT OF THE TOOL. `audit_requirements` only speaks about
    // programs already in the Plan, so until now the one question a
    // student asks while deciding was the one nobody could answer.
    const r = await ask(MATH_MINOR);
    expect(r.error, `asking about a minor the student has not declared was refused: ${r.error}`).toBeUndefined();
    expect(r.in_your_plan, "a program the student has not declared was reported as one of theirs").toBe(false);
    expect(ctx.plan!.programs, "the fixture student already has this minor, so this test proves nothing").not.toContain(
      MATH_MINOR,
    );
    expect(r.sections?.length, "no requirement sections came back for a real minor").toBeGreaterThan(0);
  });

  it("gives section headings and credit figures, not a bare list of course codes", async () => {
    // "Select 12 credits of 400-level MATH" is an answer a student can
    // act on. "MATH 401, MATH 403, MATH 405..." is a wall they cannot.
    const r = await ask(MATH_MINOR);
    for (const s of r.sections ?? []) {
      expect(s.heading.length, "a requirement section came back with no heading").toBeGreaterThan(0);
      expect(s, "a requirement section does not say how many credits it takes, even to say the bulletin gave none")
        .toHaveProperty("credits_required");
    }
    const credited = everyRequirement(r).filter((q) => typeof q.credits === "number");
    expect(credited.length, "not one requirement came back with a credit figure").toBeGreaterThan(0);
    // A named course, specifically. "Select 6 credits" carries its own
    // figure for free; a prescribed course is where a dropped credit
    // would go unnoticed, and "take MATH 140" without "it is worth 4"
    // is the half-answer this criterion exists to prevent.
    const prescribed = everyRequirement(r).find((q) => q.requirement.includes("MATH 140"));
    expect(prescribed, "the minor's prescribed MATH 140 is missing from the answer").toBeTruthy();
    expect(prescribed!.credits, "a prescribed course came back without saying what it is worth").toBe(4);
    expect(r, "the answer never says how many credits the whole program takes").toHaveProperty("total_credits");
  });

  it("says which bulletin the answer came from", async () => {
    // Requirements are an Edition-level fact. An answer that does not
    // name its Edition is one a student cannot check (ADR 0001).
    const r = await ask(MATH_MINOR);
    expect(r.edition, "the answer does not say which bulletin it came from").toBe(ctx.plan!.edition);
  });

  it("points the student at the audit for what they still need", async () => {
    // Otherwise a model reads these sections as a to-do list and starts
    // telling a student what is left, against a program they have not
    // declared and a Plan it never looked at.
    const r = await ask(MATH_MINOR);
    expect(r.note, "nothing tells the model this is not a progress report").toMatch(/audit_requirements/);
  });
});

describe("a program offered only at other campuses", () => {
  it("is reported as real, and says where it runs", async () => {
    // A student at University Park asking about Abington's accounting
    // degree must hear "that runs at Abington", never "there is no such
    // program" — which is what a tool that only checked their own
    // campus would say.
    const r = await ask(ABINGTON_ONLY);
    expect(r.error, `a program that exists at another campus was refused: ${r.error}`).toBeUndefined();
    expect(r.offered_at, "the answer does not say which campus offers this program").toBeTruthy();
    expect(r.offered_at!.join(" "), "the campus it actually runs at is not named").toMatch(/Abington/i);
    expect(r.note, "nothing warns the model against reporting an other-campus program as absent").toMatch(/campus/i);
  });

  it("does not report an unrecorded campus list as nowhere", async () => {
    // Some index entries carry no campuses at all. Answering `[]` reads
    // as "offered at no campus", which is a claim the catalog never
    // made (iron rule 2).
    const r = await ask(MATH_MINOR);
    expect(r.offered_at, "an empty campus list was published as though it meant nowhere").not.toEqual([]);
    expect(r.note, "nothing explains what a missing campus list means").toMatch(/campus/i);
  });
});

describe("a program this bulletin does not carry", () => {
  it("is refused, rather than answered from a different edition", async () => {
    // ADR 0001: Editions accumulate forward and each student is held to
    // theirs. Reaching into another to find the program would describe
    // a degree that does not govern them.
    const r = await ask("math-minor");
    expect(r.error, "a slug that is in no bulletin was answered anyway").toBeTruthy();
    expect(r.sections, "requirement sections came back for a program this bulletin does not have").toBeUndefined();
    expect(r.error, "the refusal does not say which bulletin was searched").toMatch(/2026-2027/);
  });

  it("names the editions this connector carries", async () => {
    // Without them, "not in 2026-2027" reads as "does not exist", and
    // the student is never told that the one they want may be in the
    // edition next to it.
    const r = await ask("math-minor");
    expect(r.editions_this_connector_carries, "the refusal does not say what this connector does have").toEqual(
      expect.arrayContaining(["2025-2026", "2026-2027"]),
    );
  });

  it("does not claim the program does not exist", async () => {
    const r = await ask("math-minor");
    expect(r.error, "a program we simply do not carry was reported as not existing").not.toMatch(
      /does not exist|no such program/i,
    );
  });

  it("offers the slugs it does have, so nothing is answered from memory", async () => {
    // The fabricated-electives failure in the other direction: a model
    // handed an empty refusal names a plausible program that is not at
    // Penn State (DECISIONS.md 2.5).
    const r = await ask("math-minor");
    expect(r.did_you_mean?.length, "a near miss offered no real slugs to try instead").toBeGreaterThan(0);
    for (const s of r.did_you_mean!) {
      expect(ctx.data.programs[s.slug], `${s.slug} was suggested and is not a real program`).toBeTruthy();
    }
    expect(r.note, "nothing tells the model to stop rather than invent a program").toMatch(/memory/i);
  });

  it("refuses an empty slug instead of describing something", async () => {
    const r = await ask("   ");
    expect(r.error, "a blank slug produced an answer").toMatch(/required/i);
  });

  it("still finds a slug the model retyped in capitals", async () => {
    const r = await ask(MATH_MINOR.toUpperCase());
    expect(r.error, "a slug differing only in case was refused").toBeUndefined();
    expect(r.slug).toBe(MATH_MINOR);
  });
});

describe("a requirement we could not read", () => {
  it("is reported as cannot-be-checked, never as a requirement with nothing in it", async () => {
    // IRON RULE 2, and the exact failure it exists for. An unreadable
    // elective list rendered as an empty list tells a student no course
    // qualifies, which is false, and a model will relay it.
    const r = await ask("abington-american-studies-ba");
    const unread = everyRequirement(r).filter((q) => q.status);
    expect(unread.length, "this program has no unreadable requirement, so the test proves nothing").toBeGreaterThan(0);
    for (const q of unread) {
      expect(q.status, "an unreadable requirement was reported as something other than uncheckable").toMatch(
        /cannot be checked/i,
      );
      expect(q.courses, "an unreadable requirement came back with a course list we do not have").toBeUndefined();
    }
  });

  it("never publishes an empty course list, for any program in the catalog", async () => {
    // Swept across every program rather than one, because this is the
    // property and not an example: ONE requirement rendering as
    // `courses: []` anywhere is a student being told no course
    // qualifies for a requirement whose list we simply failed to read.
    const empties: string[] = [];
    for (const slug of Object.keys(ctx.data.programs)) {
      for (const q of everyRequirement(await ask(slug))) {
        if (q.courses && q.courses.length === 0) empties.push(`${slug}: ${q.requirement}`);
      }
    }
    expect(empties, "a requirement published an empty course list, which reads as 'nothing qualifies'").toEqual([]);
  });

  it("says so for a program whose page yielded no requirements at all", async () => {
    // The ROTC entries parse to zero sections. Answering `sections: []`
    // would present a credential that requires nothing.
    const r = await ask("joint-service-rotc-army-rotc");
    expect(r.sections, "a program with no readable sections was refused rather than reported").toEqual([]);
    expect(r.status, "a program we could not read was presented as a program requiring nothing").toMatch(
      /cannot be checked/i,
    );
    expect(r.nothing_read, "nothing says the emptiness is our failure rather than the bulletin's").toMatch(
      /NOT that the program requires nothing/i,
    );
  });
});

describe("what the bulletin's own words do and do not do", () => {
  it("arrives fenced, so a requirement cannot give the model instructions", async () => {
    // DECISIONS.md 5.0 S4. These rows quote the bulletin verbatim, and
    // unmarked verbatim text in a model's context is an instruction it
    // cannot tell from data.
    const r = await ask("abington-american-studies-ba");
    const quoted = everyRequirement(r).filter((q) => q.bulletin_wording);
    expect(quoted.length, "no requirement quoted the bulletin, so fencing is untested here").toBeGreaterThan(0);
    for (const q of quoted) {
      expect(q.bulletin_wording, "bulletin wording reached the model unfenced").toMatch(
        /^<untrusted_catalog_text>[\s\S]*<\/untrusted_catalog_text>$/,
      );
    }
  });

  it("does not fence our own phrasing, which would teach the model to discount it", async () => {
    const r = await ask(MATH_MINOR);
    for (const q of everyRequirement(r)) {
      expect(q.requirement, "our own wording was marked untrusted").not.toMatch(/untrusted_catalog_text/);
      expect(q.what_counts ?? "", "our own wording was marked untrusted").not.toMatch(/untrusted_catalog_text/);
    }
  });

  it("republishes no course description", async () => {
    // DECISIONS.md 5.1: the Bulletin's prose is Penn State's expression
    // and does not ship. Courses travel as codes; the description was
    // never in this file to leak, and this is what notices if it
    // returns.
    const r = await ask(MATH_MINOR);
    expect(JSON.stringify(r), "a description field appeared on a requirements answer").not.toMatch(/"description"/);
    for (const q of everyRequirement(r)) {
      for (const code of q.courses ?? []) {
        expect(code, "a course came back as prose rather than a code").toMatch(/^[A-Z][A-Z\s-]{1,9}\s?\d/);
      }
    }
  });
});

describe("the tool as it is advertised", () => {
  it("is declared, and tells a model when to reach for something else", async () => {
    // A model that cannot tell this apart from `audit_requirements`
    // will use it for the student's own degree and report requirements
    // as outstanding without ever looking at their plan — and will
    // guess at a slug rather than searching for one.
    const t = listTools().find((x) => x.name === "get_program_requirements");
    expect(t, "get_program_requirements is not declared").toBeDefined();
    expect(t!.description, "nothing steers the model to the audit for a program the student is already in")
      .toMatch(/audit_requirements/);
    expect(t!.description, "nothing says where the slug comes from, so a model will invent one")
      .toMatch(/search_programs/);
    expect(JSON.stringify(t!.inputSchema), "the tool does not ask for a slug").toContain("slug");
  });
});
