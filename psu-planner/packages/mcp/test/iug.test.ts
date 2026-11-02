/** Attaching and detaching an integrated undergraduate-graduate degree.
 *
 * The planner has been able to do this since 2026-07-19; the connector
 * could not, because the catalog it ships carried no `iug/` at all. The
 * data was MEASURED before any of this was written (ADR 0002): 24,766
 * bytes raw and 5,202 gzipped per Edition, 0.3 MB of heap for all three
 * programmes and every graduate subject they name, against 13.8 MB for
 * the same Plan without one — see `scripts/sync-catalog.mjs` and
 * `scripts/measure-memory.mts`.
 *
 * What these assert, beyond "it works":
 *
 *   - the graduate half is folded on and comes back off, leaving the
 *     bachelor's as it was;
 *   - double-counting is the engine's, not a second implementation;
 *   - a programme slug invented by a model is ANSWERED, not raised;
 *   - and graduate policy text is reproduced verbatim, byte for byte
 *     against the catalog file, because a student checking a citation
 *     against the Graduate Bulletin has to find the same words.
 *
 * The hosted half of the same surface lives in `worker-plan.test.ts`,
 * through `fetch(Request, Env)`. Both are needed: the hosted path has
 * its own store and its own context construction, and "the local one
 * works" has never been evidence about either.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FENCE_TAG } from "@psu-planner/engine";
import { executeTool, listTools, loadContext, READABLE_PLAN_TOOLS, type ToolContext } from "../src/tools.js";
import { MUTATIONS } from "../src/mutations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const SOURCE = path.join(here, "fixtures", "plan.json");

/** The fixture is an Engineering Science B.S., which is what makes it
 * useful here: the Edition publishes an IUG against exactly that slug,
 * and ESC 404 sits in the plan AND on that programme's double-count
 * list. A fixture with neither property would exercise the plumbing and
 * none of the arithmetic. */
const ESM = "esm-esc-bs-ms";
/** Published against an Accounting bachelor's, so attaching it to this
 * plan is the mismatch case. */
const MACC = "smeal-integrated-macc";

let planPath: string;
let ctx: ToolContext;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-iug-"));
  planPath = path.join(dir, "plan.json");
  fs.copyFileSync(SOURCE, planPath);
  ctx = await loadContext({ planPath, catalogRoot: CATALOG });
});

const call = (name: string, args: Record<string, unknown> = {}) =>
  executeTool(name, { based_on_revision: ctx.rev, ...args }, ctx) as Promise<Record<string, unknown>>;
const onDisk = () => JSON.parse(fs.readFileSync(planPath, "utf-8")).plan;
/** The programme as it is published, read straight off disk. The point
 * of the verbatim tests is to compare against the file rather than
 * against a string retyped into this test — a typo in a retyped quote
 * would pass while the real quote drifted. */
const published = (slug: string) =>
  JSON.parse(fs.readFileSync(path.join(CATALOG, ctx.data.edition, "iug", `${slug}.json`), "utf-8"));

describe("the integrated-degree surface", () => {
  it("offers all three tools, and classifies the two that write as writes", () => {
    const names = listTools().map((t) => t.name);
    for (const n of ["list_iug_programs", "attach_iug", "detach_iug"]) {
      expect(names, `${n} is not offered at all`).toContain(n);
    }
    expect(READABLE_PLAN_TOOLS.has("list_iug_programs"), "a pure read was classified as a write").toBe(true);
    for (const w of ["attach_iug", "detach_iug"]) {
      expect(MUTATIONS.has(w), `${w} changes a degree plan and is not classified as a mutation`).toBe(true);
    }
  });

  it("asks both writes which revision the change was computed from", () => {
    // ADR 0003. The same rule as every other write: an optional guard
    // is one a model can skip.
    for (const t of listTools().filter((t) => t.name.endsWith("_iug"))) {
      const schema = t.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(schema.required, `${t.name} does not require based_on_revision`).toContain("based_on_revision");
    }
  });
});

describe("listing the programmes a student could pair with", () => {
  it("separates the one published against their own major from the rest", async () => {
    const r = await call("list_iug_programs");
    const mine = (r.pairs_with_this_plan as { slug: string }[]).map((p) => p.slug);
    const others = (r.for_other_majors as { slug: string }[]).map((p) => p.slug);
    expect(mine, "the IUG published against this student's own major was not offered to them").toContain(ESM);
    expect(others, "an Accounting IUG was presented as pairing with an engineering plan").toContain(MACC);
    expect(mine, "a programme was listed in both halves at once").not.toContain(MACC);
  });

  it("keeps the other majors' programmes visible, with the degree each belongs to", async () => {
    // A model told only "none of these are yours" invents a reason.
    const r = await call("list_iug_programs");
    const macc = (r.for_other_majors as { slug: string; pairs_with: string[] }[]).find((p) => p.slug === MACC);
    expect(macc, "a programme vanished instead of being attributed").toBeTruthy();
    expect(macc!.pairs_with, "a programme was listed without saying whose major it is for").not.toEqual([]);
  });

  it("reports the double-count cap from the programme, not from a rule of thumb", async () => {
    const r = await call("list_iug_programs");
    const mine = (r.pairs_with_this_plan as { slug: string; double_count: { max_credits: number } }[])
      .find((p) => p.slug === ESM)!;
    expect(
      mine.double_count.max_credits,
      "the cap did not come from the programme's own published figure",
    ).toBe(published(ESM).doubleCount.maxCredits);
  });

  it("quotes the Graduate Bulletin's admission text verbatim, and links the page it is from", async () => {
    // THE CITATION TEST. A student who pastes a sentence of this into
    // the Graduate Bulletin's own search has to find it. Compared
    // against the catalog file rather than against a string typed into
    // this test, so a quote that drifts fails here even if both copies
    // drift together in prose.
    const r = await call("list_iug_programs");
    const mine = (r.pairs_with_this_plan as { slug: string; admission_requirements: string; bulletin_url: string }[])
      .find((p) => p.slug === ESM)!;
    const spec = published(ESM);
    expect(
      mine.admission_requirements,
      "the admission text was reshaped on the way out; a student checking the citation would not find these words",
    ).toBe(`<${FENCE_TAG}>${spec.applyText}</${FENCE_TAG}>`);
    expect(mine.bulletin_url, "the quote travels without the page it came from").toBe(spec.sourceUrl);
  });

  it("keeps the Graduate Bulletin's own word 'semester' where it is quoting policy", async () => {
    // CONTEXT.md: policy text is quotation, not house vocabulary. The
    // planner says Term everywhere else; GCAC-210 says semester, and a
    // student checking the citation must find the same word.
    const r = await call("list_iug_programs");
    expect(
      String(r.admission),
      "GCAC-210's own wording was translated into house vocabulary, breaking the citation",
    ).toMatch(/semester/);
    expect(String(r.admission), "the policy was quoted without naming itself").toMatch(/GCAC-210/);
  });
});

describe("attaching the master's", () => {
  it("folds graduate terms on after the bachelor's and leaves the undergraduate half in place", async () => {
    const before = onDisk().terms.length;
    const ugCodes = onDisk().terms.flatMap((t: { items: { code?: string }[] }) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])),
    );
    const r = await call("attach_iug", { slug: ESM });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const after = onDisk();
    expect(after.iug?.slug, "the plan does not record which IUG it carries").toBe(ESM);
    expect(after.terms.length, "no graduate terms were added").toBeGreaterThan(before);
    const gradTerms = after.terms.filter((t: { phase?: string }) => t.phase === "grad");
    expect(gradTerms.length, "the added terms were not marked as the graduate phase").toBeGreaterThan(0);

    // The graduate half goes AFTER the bachelor's, not interleaved.
    const firstGrad = after.terms.findIndex((t: { phase?: string }) => t.phase === "grad");
    expect(
      after.terms.slice(firstGrad).every((t: { phase?: string }) => t.phase === "grad"),
      "an undergraduate term was left sitting after the graduate ones",
    ).toBe(true);

    const stillThere = after.terms.flatMap((t: { items: { code?: string }[] }) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])),
    );
    for (const c of ugCodes) {
      expect(stillThere, `${c} was dropped from the bachelor's by attaching a master's`).toContain(c);
    }
  });

  it("double-counts coursework already in the plan, and names what it counted twice", async () => {
    // ESC 404 is in the fixture AND on this programme's eligible list.
    // Double-counting it is the entire point of an IUG, so a run that
    // reports none has either lost the eligible list or lost the plan.
    const r = await call("attach_iug", { slug: ESM });
    expect(
      r.double_counted,
      "nothing was double-counted, so the student is being asked to take a course they already have",
    ).toContain("ESC 404");
    expect(onDisk().iug.doubleCounted, "the double-count was reported but not saved").toContain("ESC 404");
    expect(
      (r.double_counted as string[]).length * 3,
      "more credits were double-counted than the programme's cap allows",
    ).toBeLessThanOrEqual(published(ESM).doubleCount.maxCredits);
  });

  it("does not schedule a double-counted course a second time", async () => {
    await call("attach_iug", { slug: ESM });
    const grad = onDisk().terms.filter((t: { phase?: string }) => t.phase === "grad");
    const gradCodes = grad.flatMap((t: { items: { code?: string }[] }) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])),
    );
    expect(
      gradCodes,
      "a course counting toward both degrees was scheduled again in the graduate half",
    ).not.toContain("ESC 404");
  });

  it("reads the graduate subjects, so the plan can say anything at all about them", async () => {
    // MEASURED, and not what the first version of this claimed. Credits
    // are fine without it — the always-loaded audit index carries
    // `creditsParsed` for graduate courses too. What is NOT fine is the
    // prerequisite structure, which lives only in the subject files: an
    // unread graduate course comes back `"check"`, and with no load at
    // all EVERY graduate course does.
    //
    // The Accounting IUG on an engineering plan is the case that shows
    // it. ACCTG and BA are subjects this Plan never pulls in on its
    // own, so if they arrive it is because the attach went and got them.
    const r = await call("attach_iug", { slug: MACC });
    const gradTerms = (r.plan as { terms: { index: number; courses: { code: string; prerequisites: string }[] }[] })
      .terms.slice(onDisk().terms.findIndex((t: { phase?: string }) => t.phase === "grad"));
    const graduate = gradTerms.flatMap((t) => t.courses).filter((c) => /^(ACCTG|BA) /.test(c.code));
    expect(graduate.length, "the attach scheduled no graduate courses, so this proves nothing").toBeGreaterThan(0);
    expect(
      graduate.filter((c) => c.prerequisites !== "check").length,
      "every graduate course came back as 'check' — their subject files were never read, so the " +
        "connector can say nothing about whether the graduate schedule is legal",
    ).toBeGreaterThan(0);
  });

  it("quotes the admission requirements verbatim on the change itself", async () => {
    const r = await call("attach_iug", { slug: ESM });
    expect(
      r.admission_requirements,
      "the attach reported admission requirements that are not what the Bulletin says",
    ).toBe(`<${FENCE_TAG}>${published(ESM).applyText}</${FENCE_TAG}>`);
  });

  it("warns when the programme is published against a different bachelor's", async () => {
    // Not refused: the planner's own menu lists every programme, and a
    // connector stricter than the planner about something neither can
    // verify is its own kind of wrong answer. Doing it SILENTLY is the
    // failure being prevented.
    const r = await call("attach_iug", { slug: MACC });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(
      String(r.warning ?? ""),
      "an Accounting master's was attached to an engineering plan with no warning at all",
    ).toMatch(/smeal-business-accounting-bs/);
  });

  it("answers a programme slug it does not publish, rather than raising", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = await call("attach_iug", { slug: "mit-media-lab-iug" });
    expect(r.ok, "a programme nobody publishes was attached").not.toBe(true);
    expect(String(r.error), "the refusal did not say what was wrong").toMatch(/not an integrated program/i);
    expect(String(r.remedy ?? ""), "the model was not told where real slugs come from").toMatch(/list_iug_programs/);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused attach still wrote").toBe(before);
  });

  it("answers a slug shaped like a path escape instead of throwing one", async () => {
    // The slug reaches us from a MODEL. `assertInsideCatalog` would
    // refuse a traversal by throwing, which surfaces as a crash where
    // "this edition does not publish that" is the honest answer — so
    // the slug is checked against the published index BEFORE it is ever
    // turned into a path, and nothing escapes to throw about.
    for (const nasty of ["../../editions", "..%2f..%2feditions", "/etc/passwd", "esm-esc-bs-ms/../../editions"]) {
      const r = await call("attach_iug", { slug: nasty });
      expect(r.ok, `${nasty} was accepted as a programme slug`).not.toBe(true);
      expect(String(r.error), `${nasty} produced something other than a plain answer`).toMatch(
        /not an integrated program/i,
      );
    }
  });

  it("states the revision it was computed from, and advances it", async () => {
    const base = ctx.rev;
    const r = await call("attach_iug", { slug: ESM });
    expect(r.based_on_revision, "the attach did not say what it was based on").toBe(base);
    expect(r.revision, "the revision did not advance").toBe((base ?? 0) + 1);
  });

  it("is refused on a stale revision, and writes nothing", async () => {
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await executeTool("attach_iug", { slug: ESM, based_on_revision: (ctx.rev ?? 0) - 1 }, ctx)) as Record<string, unknown>;
    expect(r.ok, "an attach computed from a plan that no longer exists landed").not.toBe(true);
    expect(r.stale_read, "the refusal was not reported as a stale read").toBe(true);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused attach still wrote to the plan").toBe(before);
  });

  it("is refused without a revision at all", async () => {
    const r = (await executeTool("attach_iug", { slug: ESM }, ctx)) as Record<string, unknown>;
    expect(String(r.error), "an attach landed without naming the revision it came from").toMatch(/based_on_revision/);
  });

  it("survives a re-optimize with the graduate half intact", async () => {
    // DECISIONS.md 4.1: the optimizer re-flows the undergraduate half
    // and re-appends the graduate terms. If that ever stopped being
    // true, a student's master's would vanish the next time anyone
    // asked to graduate sooner.
    await call("attach_iug", { slug: ESM });
    const gradBefore = onDisk().terms.filter((t: { phase?: string }) => t.phase === "grad").length;
    // THE GUARD THAT STOPS THIS PASSING VACUOUSLY. Without it, an
    // implementation that drops the graduate terms on EVERY re-flow
    // compares nothing against nothing and goes green — verified by
    // breaking it exactly that way.
    expect(gradBefore, "there were no graduate terms to preserve, so this test proves nothing").toBeGreaterThan(0);
    const r = await executeTool("optimize_schedule", { based_on_revision: ctx.rev }, ctx) as Record<string, unknown>;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(onDisk().iug?.slug, "optimizing threw the master's away").toBe(ESM);
    expect(
      onDisk().terms.filter((t: { phase?: string }) => t.phase === "grad").length,
      "the graduate terms did not survive a re-optimize",
    ).toBe(gradBefore);
  });
});

describe("detaching the master's", () => {
  it("returns the plan to a plain bachelor's", async () => {
    const ugTerms = onDisk().terms.length;
    const ugCodes = onDisk().terms.flatMap((t: { items: { code?: string }[] }) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])),
    );
    await call("attach_iug", { slug: ESM });
    const r = await executeTool("detach_iug", { based_on_revision: ctx.rev }, ctx) as Record<string, unknown>;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.detached, "the answer did not say which programme came off").toBe(ESM);

    const after = onDisk();
    expect(after.iug, "the plan still claims to carry an IUG").toBeFalsy();
    expect(
      after.terms.some((t: { phase?: string }) => t.phase === "grad"),
      "graduate terms were left behind after detaching",
    ).toBe(false);
    // NOT "back to exactly eight terms". Detaching re-optimises the
    // undergraduate half, as the planner's own detach does, and the
    // fixture's published pacing repacks into seven — so pinning the
    // original number would be asserting that the optimiser does
    // nothing. What must hold is that nothing graduate is left and the
    // plan did not GROW.
    expect(
      after.terms.length,
      "detaching left the plan longer than the bachelor's it started as",
    ).toBeLessThanOrEqual(ugTerms);
    const stillThere = after.terms.flatMap((t: { items: { code?: string }[] }) =>
      t.items.flatMap((i) => (i.code ? [i.code] : [])),
    );
    for (const c of ugCodes) {
      expect(stillThere, `${c} was lost from the bachelor's by removing the master's`).toContain(c);
    }
  });

  it("says there is nothing to remove rather than reporting a change", async () => {
    // "Removed it" on a plan that never had one is a confident wrong
    // answer about something that did not happen, and a model repeats
    // it to the student as fact.
    const before = fs.readFileSync(planPath, "utf-8");
    const r = await call("detach_iug");
    expect(r.ok, "a detach reported success on a plan with no master's").not.toBe(true);
    expect(String(r.error), "the refusal did not explain itself").toMatch(/no integrated master/i);
    expect(fs.readFileSync(planPath, "utf-8"), "a no-op detach still wrote").toBe(before);
  });

  it("is refused on a stale revision, and writes nothing", async () => {
    await call("attach_iug", { slug: ESM });
    const before = fs.readFileSync(planPath, "utf-8");
    const r = (await executeTool("detach_iug", { based_on_revision: (ctx.rev ?? 0) - 1 }, ctx)) as Record<string, unknown>;
    expect(r.ok, "a detach computed from a plan that no longer exists landed").not.toBe(true);
    expect(r.stale_read, "the refusal was not reported as a stale read").toBe(true);
    expect(fs.readFileSync(planPath, "utf-8"), "a refused detach still wrote to the plan").toBe(before);
  });
});

describe("the Edition an IUG is read from", () => {
  it("is the plan's own, never the newest published", async () => {
    // ADR 0001. A graduate requirement list from a bulletin that does
    // not govern this student is somebody else's degree.
    const r = await call("list_iug_programs");
    expect(r.edition, "the IUG list came from a different bulletin than the plan").toBe(ctx.data.edition);
    const attached = await call("attach_iug", { slug: ESM });
    expect(
      (attached.plan as { edition?: string }).edition,
      "attaching re-based the student onto a different bulletin",
    ).toBe(ctx.data.edition);
    expect(onDisk().edition, "the stored plan was re-pinned").toBe(ctx.data.edition);
  });
});
