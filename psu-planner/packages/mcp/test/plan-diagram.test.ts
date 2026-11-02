/** `plan_diagram` — the Plan as a picture a chat window can draw.
 *
 * TESTED AS TEXT, NEVER AS A RENDERING. What ships is Mermaid source,
 * so what is asserted is Mermaid source: that it parses, that it names
 * the Plan's own Terms, and — the one that matters — that every arrow
 * in it corresponds to a prerequisite relation the catalog actually
 * states. A screenshot comparison would tell us a layout engine still
 * works and nothing at all about whether we are lying to a student
 * about what they must take first.
 *
 * The parser below is deliberately strict and deliberately small. It
 * accepts exactly the Mermaid subset `planDiagram.ts` emits and rejects
 * everything else, so a generator change that starts emitting a shape
 * nobody vetted fails here rather than in a student's chat window.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { astCourses, type Catalog } from "@psu-planner/engine";
import { resetInMemoryCounters, type KVLike } from "@psu-planner/identity";
import { CATALOG_ONLY, executeTool, loadContext, listTools, needsPlan, type ToolContext } from "../src/tools.js";
import worker, { type Env } from "../src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(here, "..", "catalog");
const FIXTURE = path.join(here, "fixtures", "plan.json");

// ---------------------------------------------------------------------------
// A Mermaid flowchart parser, limited to what this tool emits.
// ---------------------------------------------------------------------------

interface Edge { from: string; to: string; kind: "prereq" | "concurrent" | "out-of-order"; label: string }
interface Chart {
  terms: string[];
  nodes: Map<string, { label: string; shape: "box" | "slot"; term: string | null }>;
  edges: Edge[];
  classes: Map<string, string>;
}

const NODE = /^([A-Za-z][A-Za-z0-9_]*)\[(\/?)"([^"]*)"\2\]$/;
const SUBGRAPH = /^subgraph ([A-Za-z][A-Za-z0-9_]*)\["([^"]*)"\]$/;
const CLASSDEF = /^classDef ([A-Za-z][A-Za-z0-9_]*) \S+$/;
const CLASS = /^class ([A-Za-z0-9_,]+) ([A-Za-z][A-Za-z0-9_]*)$/;
const PLAIN = /^([A-Za-z][A-Za-z0-9_]*) --> ([A-Za-z][A-Za-z0-9_]*)$/;
const THICK = /^([A-Za-z][A-Za-z0-9_]*) ==>\|"([^"]*)"\| ([A-Za-z][A-Za-z0-9_]*)$/;
const DOTTED = /^([A-Za-z][A-Za-z0-9_]*) -\. "([^"]*)" \.-> ([A-Za-z][A-Za-z0-9_]*)$/;

/** Parse, or throw saying which line defeated it.
 *
 * Throwing on an unrecognised line is the point: an "ignore what you do
 * not understand" parser would call a diagram valid precisely when the
 * generator had started emitting something new and unreviewed. */
function parseMermaid(src: string): Chart {
  const lines = src.split("\n");
  expect(lines[0], "a Mermaid flowchart has to declare itself on the first line").toBe("flowchart LR");

  const chart: Chart = { terms: [], nodes: new Map(), edges: [], classes: new Map() };
  const classDefs = new Set<string>();
  let open: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    for (const ch of raw) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code >= 32 || code === 9, `line ${i + 1} carries a control character`).toBe(true);
    }
    expect((line.match(/"/g) ?? []).length % 2, `line ${i + 1} has an unbalanced quote: ${line}`).toBe(0);

    /** Inside a quoted label, `<` is only ever ours — the `<br/>` that
     * breaks a line. An escaped catalog title reads `#lt;`; a raw
     * bracket here means a title walked in unescaped and will swallow
     * the rest of the label when Mermaid reads it as a tag. */
    const checkLabel = (text: string, what: string) => {
      expect(text.replace(/<br\/>/g, ""), `${what} on line ${i + 1} has an unescaped angle bracket`)
        .not.toMatch(/[<>]/);
      return text;
    };

    let m: RegExpExecArray | null;
    if ((m = SUBGRAPH.exec(line))) {
      expect(open, `subgraph ${m[1]} opened inside ${open}`).toBeNull();
      open = m[1];
      chart.terms.push(checkLabel(m[2], `the title of subgraph ${m[1]}`));
    } else if (line === "end") {
      expect(open, `an 'end' on line ${i + 1} closes nothing`).not.toBeNull();
      open = null;
    } else if (line === "direction TB") {
      expect(open, "a direction outside a subgraph would turn the whole chart").not.toBeNull();
    } else if ((m = CLASSDEF.exec(line))) {
      classDefs.add(m[1]);
    } else if ((m = CLASS.exec(line))) {
      for (const id of m[1].split(",")) {
        expect(chart.nodes.has(id), `class line names node ${id}, which is never declared`).toBe(true);
        chart.classes.set(id, m[2]);
      }
      expect(classDefs.has(m[2]), `class ${m[2]} is used but never defined`).toBe(true);
    } else if ((m = NODE.exec(line))) {
      expect(chart.nodes.has(m[1]), `node ${m[1]} is declared twice`).toBe(false);
      chart.nodes.set(m[1], {
        label: checkLabel(m[3], `the label of node ${m[1]}`),
        shape: m[2] ? "slot" : "box",
        term: open,
      });
    } else if ((m = PLAIN.exec(line)) || (m = THICK.exec(line)) || (m = DOTTED.exec(line))) {
      const [from, to, lbl] =
        m.length === 3 ? [m[1], m[2], ""] : [m[1], m[3], m[2]];
      // AN EDGE INSIDE A SUBGRAPH PULLS ITS NODES INTO THAT SUBGRAPH,
      // which would silently move a Course into a Term the Plan does
      // not put it in. Mermaid accepts it; a student would be misled.
      expect(open, `edge ${from}->${to} is inside subgraph ${open}`).toBeNull();
      chart.edges.push({
        from,
        to,
        kind: lbl === "" ? "prereq" : lbl === "same term allowed" ? "concurrent" : "out-of-order",
        label: checkLabel(lbl, `the label on edge ${from}->${to}`),
      });
    } else {
      throw new Error(`line ${i + 1} is not Mermaid this tool is allowed to emit: ${JSON.stringify(line)}`);
    }
  }

  expect(open, `subgraph ${open} is never closed`).toBeNull();
  for (const e of chart.edges) {
    expect(chart.nodes.has(e.from), `edge from ${e.from}, which is never declared`).toBe(true);
    expect(chart.nodes.has(e.to), `edge to ${e.to}, which is never declared`).toBe(true);
  }
  return chart;
}

/** The course code a node's label leads with, or null for a Slot. */
function codeOf(node: { label: string; shape: string }): string | null {
  if (node.shape === "slot") return null;
  return node.label.split("<br/>")[0];
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const tmps: string[] = [];
afterEach(() => {
  for (const f of tmps.splice(0)) fs.rmSync(f, { force: true });
});

/** The fixture Plan, optionally bent into the shape a test needs. */
async function contextWith(edit: (plan: Record<string, unknown>) => void): Promise<ToolContext> {
  const doc = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
  edit(doc.plan);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lionsdegree-diagram-")), "plan.json");
  tmps.push(file);
  fs.writeFileSync(file, JSON.stringify(doc));
  return loadContext({ planPath: file, catalogRoot: CATALOG });
}

let ctx: ToolContext;
let chart: Chart;
let result: Record<string, unknown>;

beforeAll(async () => {
  ctx = await loadContext({ planPath: FIXTURE, catalogRoot: CATALOG });
  result = (await executeTool("plan_diagram", {}, ctx)) as Record<string, unknown>;
  chart = parseMermaid(String(result.diagram));
});

const draw = async (c: ToolContext, args: Record<string, unknown> = {}) =>
  (await executeTool("plan_diagram", args, c)) as Record<string, unknown>;

// ---------------------------------------------------------------------------

describe("a student asking to see their degree", () => {
  it("is offered the tool at all", () => {
    const t = listTools().find((x) => x.name === "plan_diagram");
    expect(t, "plan_diagram is not declared, so no model can call it").toBeDefined();
    expect(t!.description, "the description does not say what shape comes back").toMatch(/mermaid/i);
  });

  it("gets Mermaid that parses", () => {
    expect(result.format, "the model is not told what the text is").toBe("mermaid");
    expect(String(result.diagram).startsWith("flowchart "), "this is not a Mermaid flowchart").toBe(true);
    expect(chart.nodes.size, "a diagram of a plan with courses in it drew nothing").toBeGreaterThan(10);
  });

  it("organises it by Term, naming every Term the Plan has", () => {
    // TERMS ARE THE STRUCTURE, which is the whole reason this beats a
    // list: a student reading a list has to hold eight terms in their
    // head to see the shape of their own degree.
    expect(chart.terms.length, "the diagram has a different number of terms from the plan").toBe(
      ctx.plan!.terms.length,
    );
    for (const term of ctx.plan!.terms) {
      expect(
        chart.terms.some((t) => t.startsWith(term.label)),
        `the diagram never names the term "${term.label}"`,
      ).toBe(true);
    }
  });

  it("draws every Course in the Plan, and every open Slot", () => {
    const drawn = new Set([...chart.nodes.values()].map(codeOf).filter(Boolean));
    for (const it of ctx.items) {
      if (it.kind !== "course" || !it.code) continue;
      expect(drawn.has(it.code), `${it.code} is in the plan and missing from the diagram`).toBe(true);
    }
    const slots = ctx.items.filter((i) => i.kind === "slot").length;
    expect(
      [...chart.nodes.values()].filter((n) => n.shape === "slot").length,
      "the diagram lost an open requirement slot",
    ).toBe(slots);
  });

  it("puts each Course in the box for the Term it is actually in", () => {
    for (const it of ctx.items) {
      if (it.kind !== "course" || !it.code) continue;
      const node = [...chart.nodes.values()].find((n) => codeOf(n) === it.code)!;
      const term = chart.terms[ctx.plan!.terms.findIndex((_, i) => i === it.sem)];
      expect(node.term, `${it.code} is drawn outside any term box`).not.toBeNull();
      expect(
        chart.terms[Number(node.term!.replace("term", ""))],
        `${it.code} is drawn in the wrong term`,
      ).toBe(term);
    }
  });
});

describe("the edges, which are the part that can be a confident wrong answer", () => {
  it("draws an edge ONLY where the catalog states that prerequisite relation", () => {
    // THE ASSERTION THIS WHOLE FILE EXISTS FOR. Derived independently
    // of the generator: the generator reads evaluation leaves, this
    // reads the prerequisite AST's own course codes. An edge the
    // bulletin does not state is a confident wrong answer about what a
    // student must take first, which is iron rule 2 exactly.
    const cat: Catalog = ctx.data.catalog;
    expect(chart.edges.length, "no edges at all — the check below would pass vacuously").toBeGreaterThan(5);

    for (const e of chart.edges) {
      const to = codeOf(chart.nodes.get(e.to)!)!;
      const from = codeOf(chart.nodes.get(e.from)!)!;
      const c = cat[to];
      expect(c, `an edge points at ${to}, which is not in the catalog at all`).toBeTruthy();

      // Every Course code this one's prerequisites name, mapped through
      // the schedule the way the engine does — a requirement naming
      // "MATH 140" is satisfied by the student's "MATH 140H", and the
      // box on the chart is the honors section they are taking.
      const named = new Set<string>();
      for (const ast of [c.prereqAst, c.concurrentAst]) {
        if (!ast) continue;
        for (const code of astCourses(ast)) {
          named.add(code);
          const viaSchedule = ctx.sched[code]?.item.code;
          if (viaSchedule) named.add(viaSchedule);
        }
      }
      expect(
        named.has(from),
        `the diagram draws ${from} -> ${to}, but ${to}'s prerequisites never name ${from}. ` +
          `They name: ${[...named].join(", ") || "nothing"}`,
      ).toBe(true);
    }
  });

  it("draws the prerequisite relations the catalog DOES state", () => {
    // The other half, or "draw nothing" would pass the test above.
    // PHYS 212 enforces PHYS 211 and both are in this plan.
    const named = (from: string, to: string) =>
      chart.edges.some(
        (e) => codeOf(chart.nodes.get(e.from)!) === from && codeOf(chart.nodes.get(e.to)!) === to,
      );
    expect(named("PHYS 211", "PHYS 212"), "PHYS 211 -> PHYS 212 is in the catalog and not on the chart").toBe(true);
    expect(named("ESC 410H", "ESC 411"), "ESC 410H -> ESC 411 is in the catalog and not on the chart").toBe(true);
  });

  it("draws no edge between two Courses with no relation between them", () => {
    const between = (a: string, b: string) =>
      chart.edges.some((e) => {
        const f = codeOf(chart.nodes.get(e.from)!);
        const t = codeOf(chart.nodes.get(e.to)!);
        return (f === a && t === b) || (f === b && t === a);
      });
    expect(between("ECON 102", "CHEM 110"), "an arrow appeared between two unrelated courses").toBe(false);
    expect(between("CAS 100A", "MATH 220"), "an arrow appeared between two unrelated courses").toBe(false);
  });

  it("draws no edge to a Course that is not on the chart", () => {
    // MATH 140 is completed and off the chart; MATH 141 requires it.
    // `buildSchedule` keeps it as a cardless `sem: -1` entry, and an
    // edge to a box that does not exist would either break the parse
    // or invent a term for a course the student already finished.
    const codes = new Set([...chart.nodes.values()].map(codeOf));
    expect(codes.has("MATH 140"), "a completed course off the chart was drawn a box").toBe(false);
  });

  it("marks a prerequisite that may be taken in the same term as such", () => {
    const sameTerm = chart.edges.filter((e) => e.kind === "concurrent");
    expect(sameTerm.length, "no concurrent prerequisite was distinguished in a plan that has them")
      .toBeGreaterThan(0);
    for (const e of sameTerm) {
      expect(e.label, "a concurrent edge lost its explanation").toBe("same term allowed");
    }
  });

  it("marks a relation the student's ordering breaks, rather than hiding it", async () => {
    // A red edge on the planner's chart. The relation is real and the
    // schedule violates it; drawing it as an ordinary arrow would tell
    // a student the order is fine.
    const broken = await contextWith((plan) => {
      (plan as { moves: Record<string, number> }).moves["PHYS 211"] = 5;
    });
    const c = parseMermaid(String((await draw(broken)).diagram));
    const bad = c.edges.filter((e) => e.kind === "out-of-order");
    expect(bad.length, "PHYS 211 was moved after PHYS 212 and no edge said so").toBeGreaterThan(0);
    for (const e of bad) {
      expect(e.label, "an out-of-order edge did not say what was wrong").toBe("scheduled out of order");
    }
  });
});

describe("the three states, which must not become two", () => {
  it("says 'cannot be checked' in those words, never 'satisfied'", () => {
    // DECISIONS.md §2.1 and CONTEXT.md's Unknown: a requirement we
    // could not evaluate is distinct from unmet and is NEVER collapsed
    // into satisfied. The fixture carries courses in both states.
    const states = [...chart.nodes.values()]
      .filter((n) => n.shape === "box")
      .map((n) => n.label.split("<br/>")[2]);
    expect(
      states.filter((s) => s === "prerequisites cannot be checked").length,
      "nothing in this plan reads 'cannot be checked', so this test proves nothing",
    ).toBeGreaterThan(0);
    expect(
      states.filter((s) => s === "prerequisites satisfied").length,
      "nothing in this plan reads 'satisfied'",
    ).toBeGreaterThan(0);
    for (const s of states) {
      expect(
        ["prerequisites satisfied", "prerequisites cannot be checked", "prerequisites NOT satisfied"],
        `a course box reads "${s}", which is not one of the engine's three states`,
      ).toContain(s);
    }
  });

  it("paints the three states with three different classes", () => {
    // Colour is a second channel, not the only one — but it must not
    // merge two states either. A shared class is a shared colour, and a
    // student skimming colour would read an open question as a yes.
    const classOf = (state: string) => {
      const ids = [...chart.nodes.entries()]
        .filter(([, n]) => n.shape === "box" && n.label.split("<br/>")[2] === state)
        .map(([id]) => chart.classes.get(id));
      return new Set(ids);
    };
    const satisfied = classOf("prerequisites satisfied");
    const unchecked = classOf("prerequisites cannot be checked");
    expect(satisfied.size, "courses in one state carry more than one class").toBe(1);
    expect(unchecked.size, "courses in one state carry more than one class").toBe(1);
    expect(
      [...satisfied][0],
      "'satisfied' and 'cannot be checked' are painted the same, which collapses them for anyone skimming",
    ).not.toBe([...unchecked][0]);
  });

  it("reaches all three on a plan that has all three", async () => {
    const broken = await contextWith((plan) => {
      (plan as { moves: Record<string, number> }).moves["PHYS 211"] = 5;
    });
    const c = parseMermaid(String((await draw(broken)).diagram));
    const states = new Set(
      [...c.nodes.values()].filter((n) => n.shape === "box").map((n) => n.label.split("<br/>")[2]),
    );
    expect(states, "a plan with a broken prerequisite never says so").toContain("prerequisites NOT satisfied");
    expect(states, "the unknown state vanished").toContain("prerequisites cannot be checked");
    expect(states, "the satisfied state vanished").toContain("prerequisites satisfied");
  });

  it("does not draw a Course this Edition has never heard of as satisfied", async () => {
    // `checkCourse` answers SAT for a code it cannot find — it has no
    // requirements to fail. That is right for the engine and
    // catastrophic as a picture: the ESC 410 incident (DECISIONS.md
    // §2.4) rendered in green.
    const bogus = await contextWith((plan) => {
      (plan as { terms: { items: unknown[] }[] }).terms[0].items.push({ code: "ZZZZ 999" });
    });
    const c = parseMermaid(String((await draw(bogus)).diagram));
    const node = [...c.nodes.values()].find((n) => codeOf(n) === "ZZZZ 999");
    expect(node, "a course in the plan was dropped from the diagram instead of drawn honestly").toBeDefined();
    expect(
      node!.label,
      "a course the catalog does not carry was drawn as though its prerequisites were met",
    ).not.toContain("prerequisites satisfied");
    expect(node!.label, "nothing told the student why this course could not be checked").toContain(
      "not in this edition's catalog",
    );
  });
});

describe("what the diagram is allowed to contain", () => {
  it("carries no Bulletin prose — only codes, titles, credits and our own words", () => {
    // DECISIONS.md §5.1: codes, credits and titles are facts; the
    // University's descriptions and requirement wording are its
    // expression and are not republished. Asserted by construction
    // rather than by scanning for suspicious text: every segment of
    // every course label has to be one of four known things.
    const cat: Catalog = ctx.data.catalog;
    const allowed = new Set([
      "prerequisites satisfied",
      "prerequisites cannot be checked",
      "prerequisites NOT satisfied",
      "already completed",
      "not in this edition's catalog — unverified",
    ]);
    for (const node of chart.nodes.values()) {
      if (node.shape !== "box") continue;
      const [code, title, ...rest] = node.label.split("<br/>");
      expect(cat[code], `${code} is drawn but is not a catalog code`).toBeTruthy();
      expect(title, `the title drawn for ${code} is not the catalog's own title`).toBe(cat[code].title);
      for (const part of rest) {
        expect(allowed, `${code}'s label carries text that is not one of our own phrases: "${part}"`).toContain(part);
      }
    }
  });

  it("escapes a title that would otherwise break the label", async () => {
    // A quote closes the label early and leaves Mermaid parsing the
    // rest of a course name as syntax; an angle bracket is read as the
    // start of a tag and swallows what follows. Either way the student
    // gets a parse error where their degree should be. No title in the
    // shipped catalog contains one today, which is exactly why this
    // injects them — a guard that only fires on data we happen not to
    // have is a guard nobody will notice losing.
    const c = await contextWith(() => {});
    c.data.catalog["CHEM 110"] = {
      ...c.data.catalog["CHEM 110"],
      title: 'Chemistry "I" <b>& more</b>',
    };
    const parsed = parseMermaid(String((await draw(c)).diagram));
    const node = [...parsed.nodes.values()].find((n) => codeOf(n) === "CHEM 110");
    expect(node, "the course with the awkward title vanished from the diagram").toBeDefined();
    expect(node!.label, "a double quote in a title was not escaped").toContain("#quot;I#quot;");
    expect(node!.label, "an angle bracket in a title was not escaped").toContain("#lt;b#gt;");
    expect(node!.label, "a raw quote survived into the label").not.toContain('"');
  });

  it("sends the student to the real chart, which is better than this one", () => {
    expect(
      String(result.open_the_real_chart),
      "the answer never points at the planner's own transit map",
    ).toMatch(/^https?:\/\/\S+\/plan\/$/);
  });

  it("tells the model what the shapes mean, so it does not invent its own reading", () => {
    expect(String(result.what_an_edge_means), "nothing says what an arrow claims").toMatch(/prerequisite/i);
    expect(
      String(result.what_an_edge_means),
      "nothing warns that alternatives each get their own arrow, so two arrows can mean 'either'",
    ).toMatch(/alternativ/i);
    expect(String(result.how_to_show_this), "the model is not told to reproduce it verbatim").toMatch(
      /verbatim/i,
    );
  });
});

describe("drawing a change before taking it", () => {
  it("draws the candidate plan a change would produce", async () => {
    const r = await draw(ctx, { change: "add_term", arguments: {} });
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    const c = parseMermaid(String(r.diagram));
    expect(c.terms.length, "add_term was previewed and the drawing has the same number of terms").toBe(
      ctx.plan!.terms.length + 1,
    );
  });

  it("cannot be read as having made the change", async () => {
    const r = await draw(ctx, { change: "add_term", arguments: {} });
    expect(r.applied, "a preview reports applied: true").toBe(false);
    expect(r.simulated, "a preview does not say it is one").toBe(true);
    expect(String(r.nothing_changed), "nothing says the stored plan is untouched").toMatch(/has not been changed/i);
    expect(r.ok, "a preview carries the success flag a real mutation returns").toBeUndefined();
    expect(r.revision, "a preview carries a revision, which a student would quote as proof of a save")
      .toBeUndefined();
  });

  it("leaves the stored plan byte-identical", async () => {
    const before = fs.readFileSync(FIXTURE, "utf-8");
    await draw(ctx, { change: "add_term", arguments: {} });
    expect(fs.readFileSync(FIXTURE, "utf-8"), "drawing a preview wrote to the student's plan").toBe(before);
  });

  it("refuses a change computed from a revision the plan has moved past", async () => {
    const r = await draw(ctx, { change: "add_term", arguments: { based_on_revision: 9999 } });
    expect(r.diagram, "a stale revision still produced a picture").toBe("");
    expect(String(r.reason), "the refusal does not say why").toMatch(/revision/i);
  });

  it("says plainly when the change is not one that can be drawn", async () => {
    const r = await draw(ctx, { change: "set_fire_to_the_plan", arguments: {} });
    expect(String(r.error), "an unknown change was not named as such").toMatch(/cannot be simulated/i);
    expect(r.diagram, "an unknown change still produced a picture").toBe("");
  });
});

// ---------------------------------------------------------------------------
// Through the Worker, because that is the thing students actually reach.
// ---------------------------------------------------------------------------

const SECRET = "test-jwt-secret";

const assets = {
  async fetch(req: Request): Promise<Response> {
    const rel = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
    const file = path.join(CATALOG, rel);
    if (!file.startsWith(CATALOG) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(fs.readFileSync(file, "utf-8"), { status: 200 });
  },
};

function memoryKv(): KVLike {
  const store = new Map<string, string>();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function token(payload: Record<string, unknown>): Promise<string> {
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

const signedIn = () =>
  token({ sub: "student-1", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "s@psu.edu" });

const env = (): Env =>
  ({
    CATALOG: assets,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    OAUTH: memoryKv(),
  }) as Env;

function database(reply: () => Response) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

async function rpc(e: Env, auth: string | null, method: string, params: unknown) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth) headers.authorization = auth;
  const res = await worker.fetch(
    new Request("https://mcp.lionsdegree.com/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    e,
  );
  const text = await res.text();
  const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
  return { status: res.status, raw: text, body: line ? JSON.parse(line.slice(5).trim()) : null };
}

describe("plan_diagram through the hosted connector", () => {
  let db: ReturnType<typeof database> | null = null;
  afterEach(() => { db?.restore(); db = null; resetInMemoryCounters(); });

  const PLAN = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")).plan;

  it("is offered to a signed-in student", async () => {
    const r = await rpc(env(), `Bearer ${await signedIn()}`, "tools/list", {});
    const names = (r.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names, "plan_diagram is not reachable on the hosted connector").toContain("plan_diagram");
  });

  it("is refused without an account, because it is a view of one student's plan", async () => {
    // A drawing of a degree is as much that student's data as the plan
    // it is drawn from. The Worker's gate answers 401 before anything
    // is dispatched; the classification behind it is asserted below,
    // because the gate and the allowlist can fail independently.
    const r = await rpc(env(), null, "tools/call", { name: "plan_diagram", arguments: {} });
    expect(r.status, "an anonymous caller got something other than a sign-in challenge").toBe(401);
    expect(r.raw, "a diagram of someone's degree came back without an account").not.toContain("flowchart");
  });

  it("is classified as needing a Plan, so nobody can add it to the Bulletin surface by forgetting", () => {
    expect(
      needsPlan("plan_diagram"),
      "plan_diagram is on the catalog-only allowlist and would answer about a Plan nobody signed in to",
    ).toBe(true);
    expect([...CATALOG_ONLY], "plan_diagram leaked onto the unauthenticated surface").not.toContain(
      "plan_diagram",
    );
  });

  it("draws the signed-in student's own plan, end to end", async () => {
    db = database(() => Response.json([{ doc: PLAN, rev: 4, updated_at: "2026-10-20T09:00:00.000Z" }]));
    const r = await rpc(env(), `Bearer ${await signedIn()}`, "tools/call", {
      name: "plan_diagram",
      arguments: {},
    });
    const payload = JSON.parse(r.body.result.content[0].text) as Record<string, unknown>;
    expect(payload.error, JSON.stringify(payload)).toBeUndefined();

    // Parsed on the far side of the Worker, not merely non-empty: the
    // thing that reaches a student is this text, and text that does not
    // parse renders as a red error box where their degree should be.
    const c = parseMermaid(String(payload.diagram));
    for (const term of PLAN.terms as { label: string }[]) {
      expect(
        c.terms.some((t) => t.startsWith(term.label)),
        `the hosted diagram never names "${term.label}"`,
      ).toBe(true);
    }
    expect(payload.revision, "the hosted drawing does not say which revision it is of").toBe(4);
    expect(String(payload.open_the_real_chart), "no link to the planner's chart").toContain("/plan/");
  });

  it("says so rather than crashing when the student has no plan yet", async () => {
    db = database(() => Response.json([]));
    const r = await rpc(env(), `Bearer ${await signedIn()}`, "tools/call", {
      name: "plan_diagram",
      arguments: {},
    });
    const text = String(r.body.result.content[0].text);
    expect(text, "a student with no plan got a stack trace where an explanation belongs").toMatch(
      /plan/i,
    );
    expect(text, "the absence of a plan was reported as an empty degree").not.toContain("flowchart");
  });
});
