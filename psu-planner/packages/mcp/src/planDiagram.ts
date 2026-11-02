/** The Plan as a picture, in text a chat window can draw.
 *
 * MERMAID RATHER THAN AN IMAGE, deliberately. It renders in the clients
 * students actually use; where it does not, it degrades to lines of
 * legible text rather than to a broken-image box; it costs the Worker
 * nothing to produce; and it keeps a rasteriser out of a 128 MB isolate
 * that is already holding the catalog. The MCP protocol does permit
 * image content — that is a later decision with a measured memory cost
 * attached, not this one.
 *
 * THE CORRECTNESS CONSTRAINT THIS MODULE EXISTS TO HOLD. An edge here
 * is a claim about what a student must take first, and a wrong one is
 * the confident-wrong-answer shape iron rule 2 forbids (DECISIONS.md
 * §2.1, §2.5). So every edge comes from the engine's own prerequisite
 * evaluation — the same `checkCourse` the planner's chart draws from —
 * and never from a code the diagram's author thought looked like a
 * prerequisite. If the catalog does not name the relation, no line is
 * drawn.
 *
 * The second half of the same constraint is the node, not the edge. The
 * engine reports THREE states — satisfied, cannot be checked, not
 * satisfied — and the diagram keeps all three. Collapsing "cannot be
 * checked" into "satisfied" would draw a green box over a question
 * nobody has answered, which is exactly how a student registers for a
 * course they are not eligible for.
 *
 * No Bulletin prose reaches the output (DECISIONS.md §5.1). Codes,
 * titles, credits and the prerequisite relation are facts; the
 * University's descriptions and requirement wording are not published
 * here, and a label is built only from the first set.
 */
import {
  checkCourse,
  credOf,
  SAT,
  UNK,
  UNSAT,
  type Catalog,
  type EvalValue,
  type PlanDoc,
  type PlanItem,
  type Schedule,
} from "@psu-planner/engine";
import { candidateContext } from "./simulate.js";
// TYPE ONLY, so there is no runtime import back into `tools.ts` — which
// imports this module. A value import here would be a cycle.
import type { ToolContext } from "./tools.js";

/** The three states, in the words the rest of the connector uses.
 *
 * Shared wording with `simulate.ts`'s `newViolations` on purpose: a
 * student who sees "cannot be checked" on a diagram and "cannot be
 * checked" in a preview is reading one system, not two. */
const STATUS: Record<EvalValue, string> = {
  [SAT]: "prerequisites satisfied",
  [UNK]: "prerequisites cannot be checked",
  [UNSAT]: "prerequisites NOT satisfied",
};

/** The Mermaid class each state is painted with.
 *
 * Colour is never the only carrier — the state is spelled out in the
 * node's own label too. A student reading this in a client that renders
 * Mermaid without our `classDef`, or who cannot distinguish the three
 * hues, still gets the words. */
const STATUS_CLASS: Record<EvalValue, string> = {
  [SAT]: "satisfied",
  [UNK]: "unchecked",
  [UNSAT]: "unmet",
};

/** Control characters out, by code point rather than by a regex range.
 *
 * Written this way on purpose: a regex literal spelling the range needs
 * either real control bytes in this file or backslash escapes that
 * every copy-and-paste through a shell mangles, and a stray control
 * character in generated text is invisible in exactly the places this
 * output is meant to degrade gracefully into. */
function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/** Text that is safe inside a Mermaid quoted label.
 *
 * `#` goes first and on its own: it is the escape character for the
 * entities below, so escaping it afterwards would turn our own
 * `#quot;` into `#35;quot;`. Angle brackets are escaped because the
 * labels themselves use `<br/>` as a line break — an unescaped `<` in a
 * course title would be read as the start of another tag and swallow
 * the rest of the label. */
function label(text: string): string {
  return stripControl(text)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Mermaid node id from a course code or a slot id.
 *
 * Mermaid ids are bare words: a space or a hyphen inside one is read as
 * the end of the id, so `A-I 305` would parse as the node `A`. Everything
 * outside `[A-Za-z0-9]` becomes an underscore, and the prefix keeps an id
 * from ever colliding with a Mermaid keyword. Uniqueness is enforced by
 * this set rather than assumed, because two different sources (a term's
 * own Course and a filled Slot) can name the same code. */
function mermaidId(prefix: string, raw: string, taken: Set<string>): string {
  const base = `${prefix}_${raw.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/** One drawn course, and everything the diagram needs to say about it. */
interface Node {
  id: string;
  item: PlanItem;
  value: EvalValue;
}

/** What `plan_diagram` answers with.
 *
 * `diagram` is the whole point and everything else is framing for the
 * model holding it: what the shapes mean, and where the real chart is.
 * The planner's transit map is better than anything a chat window
 * renders — it is pannable, it shows credits and requirement coverage,
 * and it is the thing the student actually edits — so the link is part
 * of the answer rather than a footnote. */
export interface DiagramResult {
  format: "mermaid";
  diagram: string;
  how_to_show_this: string;
  what_the_colours_mean: string;
  what_an_edge_means: string;
  open_the_real_chart: string;
  /** Present only when the diagram is of a candidate Plan.
   *
   * Three fields rather than one, for the reason `simulate.ts` gives:
   * a model skimming for a success flag has to meet `applied: false`
   * whichever field it reads first, or it tells the student their plan
   * has been changed when it has not. */
  simulated?: true;
  applied?: false;
  nothing_changed?: string;
  change?: { tool: string; arguments: Record<string, unknown> };
  error?: string;
  [k: string]: unknown;
}

/** Draw a Plan, or a candidate Plan a change would produce.
 *
 * `change` and `arguments` are the same pair `simulate_change` takes,
 * and they run through the same `candidateContext` it does — so the
 * drawing a student is shown before they commit comes from the real
 * mutation and the real optimiser. A second "preview" implementation
 * would drift, and the drift would be a picture of a plan the planner
 * then refuses to produce. */
export async function planDiagram(
  ctx: ToolContext,
  args: { change?: unknown; arguments?: unknown } = {},
): Promise<DiagramResult> {
  if (!ctx.plan) return refusal("There is no plan to draw.");

  const change = typeof args.change === "string" ? args.change.trim() : "";
  if (!change) return draw(ctx, {});

  const changeArgs = (args.arguments ?? {}) as Record<string, unknown>;
  const candidate = await candidateContext(ctx, change, changeArgs);
  if ("refused" in candidate) {
    // The refusal `simulate_change` would have given, verbatim — it
    // already says why, what to do instead, and that nothing was
    // changed. Rewriting it here would give a student two different
    // explanations of one event depending on which tool they used.
    return { ...emptyShell(), ...candidate.refused } as DiagramResult;
  }
  return {
    // WITH NO REVISION AND NO TIMESTAMP, for the reason `simulate.ts`
    // records against the same line: the sandbox commit sets `rev` and
    // `updatedAt` on the copy, so a drawing of it comes back carrying a
    // revision that does not exist and a save that did not happen. A
    // model summarising "revision 2" tells the student their plan is
    // saved. Stripped here rather than in `candidateContext`, because
    // the mutation genuinely did advance the sandbox and the sandbox is
    // entitled to know it — the lie is only in reporting it outward.
    ...draw(
      { ...candidate.after, rev: undefined, updatedAt: undefined },
      { of: "the plan as this change would leave it" },
    ),
    simulated: true,
    applied: false,
    nothing_changed:
      "This is a drawing of a PREVIEW. The student's stored plan has not been changed. " +
      `To make this change for real, call ${change}, or tell them to do it in the planner.`,
    change: { tool: change, arguments: changeArgs },
  };
}

function emptyShell(): DiagramResult {
  return {
    format: "mermaid",
    diagram: "",
    how_to_show_this: HOW,
    what_the_colours_mean: COLOURS,
    what_an_edge_means: EDGES,
    open_the_real_chart: plannerLink(),
  };
}

function refusal(message: string): DiagramResult {
  return { ...emptyShell(), error: message };
}

const HOW =
  "Reproduce `diagram` verbatim inside a fenced code block tagged `mermaid`, as the whole of " +
  "your answer's picture. Do not redraw it, do not add courses or arrows to it, and do not " +
  "describe edges it does not contain — every line in it is a prerequisite relation the catalog " +
  "actually states, and an added one is a wrong answer about what the student must take first.";

const COLOURS =
  "Every course box also spells its state out in words, so the colours are a second channel and " +
  "never the only one. There are three states and they are not interchangeable: " +
  "'prerequisites satisfied' means the plan demonstrably meets them; 'prerequisites cannot be " +
  "checked' means we could not evaluate the requirement and it is an open question, NOT a yes; " +
  "'prerequisites NOT satisfied' means the plan as scheduled does not meet them.";

const EDGES =
  "An arrow means the later course's prerequisites, as published in the bulletin, name the " +
  "earlier one — nothing is drawn that the catalog does not state. Where a requirement offers " +
  "alternatives, each alternative that is also in the plan gets its own arrow, so two arrows " +
  "into one course may mean 'either of these' rather than 'both of these'; say so rather than " +
  "claiming both are required. A dotted arrow is a prerequisite the bulletin allows to be taken " +
  "in the same term. A thick arrow labelled 'scheduled out of order' is the planner's red edge: " +
  "the relation is real and the student's current ordering breaks it.";

/** The planner's own chart, which is better than this one.
 *
 * `process.env` is read the same way `discover_programs` reads it, and
 * guarded, because this module runs inside a Worker as well as inside
 * Node and an isolate without the Node shim has no `process` at all. */
function plannerLink(): string {
  const site =
    (typeof process !== "undefined" ? process.env?.LIONSDEGREE_SITE : undefined) ??
    "https://lionsdegree.com";
  return `${site}/plan/`;
}

/** Does this student have an adviser's say-so on file for this Course?
 *
 * The planner renders an overridden card as satisfied; a chat diagram
 * must not, because the sentence a model builds from a green box is
 * "your prerequisites are met" and the truth is "your adviser cleared
 * you anyway". So the engine's own verdict stays in the label and the
 * override is ADDED to it — the student learns both facts instead of
 * having one quietly replace the other. */
function overridden(plan: PlanDoc, code: string): boolean {
  return !!plan.prereqOverrides?.[code];
}

function draw(ctx: ToolContext, opts: { of?: string }): DiagramResult {
  const plan = ctx.plan!;
  const cat: Catalog = ctx.data.catalog;
  const { items, sched } = ctx;

  const taken = new Set<string>();
  /** Item id -> drawn node. Keyed by ITEM id, not by course code: two
   * items can carry the same code (a term's Course and a Slot filled
   * with it), and keying by code would silently merge them into one box
   * sitting in one Term. */
  const nodes = new Map<string, Node>();

  for (const it of items) {
    if (it.kind !== "course" || !it.code) continue;
    nodes.set(it.id, { id: mermaidId("c", it.code, taken), item: it, value: statusOf(cat, it, sched) });
  }

  const lines: string[] = [];
  // LR, so Terms read left to right the way the planner's transit map
  // does and the way a student reads their own degree.
  lines.push("flowchart LR");
  lines.push(...CLASS_DEFS);

  const byClass: Record<string, string[]> = { satisfied: [], unchecked: [], unmet: [], slot: [], empty: [] };

  plan.terms.forEach((term, i) => {
    const termItems = items.filter((it) => it.sem === i);
    const credits = termItems.reduce((sum, it) => sum + credOf(it, cat), 0);
    const title = label(
      `${term.label || `Term ${i + 1}`} — ${credits} credits${term.gap ? " — gap term, intentionally empty" : ""}`,
    );
    lines.push(`  subgraph term${i}["${title}"]`);
    // TB inside an LR chart: Terms march across, the Courses within one
    // Term stack down. A Term laid out left-to-right internally would
    // read as a sequence, and the Courses in a Term have no order.
    lines.push("    direction TB");

    if (!termItems.length) {
      // A Term with nothing in it still gets a box, because its
      // emptiness is information — a student looking for the gap year
      // they asked for needs to see it. An empty `subgraph` renders as
      // an unlabelled void in several clients, so it gets a placeholder.
      const id = mermaidId("e", `term${i}`, taken);
      byClass.empty.push(id);
      lines.push(`    ${id}["${label(term.gap ? "nothing planned — gap term" : "nothing planned yet")}"]`);
    }

    for (const it of termItems) {
      if (it.kind === "slot") {
        const id = mermaidId("s", it.id, taken);
        byClass.slot.push(id);
        // A SLOT HAS NO PREREQUISITES TO DRAW, because it has no Course
        // yet. Drawing none is the honest answer; drawing the
        // prerequisites of whatever we guess might fill it would be an
        // invented edge in its purest form.
        const what = it.slotLabel || it.slot || "requirement";
        lines.push(
          `    ${id}[/"${label(`${what} — ${Number(it.credits) || 0} credits`)}<br/>${label("no course chosen yet")}"/]`,
        );
        continue;
      }
      const node = nodes.get(it.id);
      if (!node) continue;
      byClass[STATUS_CLASS[node.value]].push(node.id);
      lines.push(`    ${node.id}["${courseLabel(cat, plan, it, node.value)}"]`);
    }

    lines.push("  end");
  });

  // EDGES LAST, and outside every subgraph. Mermaid accepts a link
  // declared inside a `subgraph` block and then pulls the named nodes
  // into that subgraph — so a prerequisite edge written next to its
  // dependent would silently move the earlier Course into the later
  // Term, and the picture would place a course in a Term the Plan does
  // not.
  lines.push(...edgesOf(ctx, nodes).map((e) => `  ${e}`));

  for (const [cls, ids] of Object.entries(byClass)) {
    if (ids.length) lines.push(`  class ${ids.join(",")} ${cls}`);
  }

  return {
    format: "mermaid",
    diagram: lines.join("\n"),
    how_to_show_this: HOW,
    what_the_colours_mean: COLOURS,
    what_an_edge_means: EDGES,
    open_the_real_chart: plannerLink(),
    ...(opts.of ? { this_diagram_is_of: opts.of } : {}),
    // Said rather than implied, as `get_plan` says it: a diagram drawn
    // from an hour-old read looks exactly like one drawn a second ago.
    ...(ctx.updatedAt ? { as_of: ctx.updatedAt } : {}),
    ...(ctx.rev !== undefined ? { revision: ctx.rev } : {}),
    edition: ctx.data.edition,
  };
}

const CLASS_DEFS = [
  "  classDef satisfied fill:#e6f4ea,stroke:#1e7a3c,color:#10351f",
  "  classDef unchecked fill:#fdf3d8,stroke:#9a6b00,color:#3d2a00",
  "  classDef unmet fill:#fbe4e4,stroke:#a81f1f,color:#3f0d0d",
  "  classDef slot fill:#eef1f4,stroke:#5a6b7a,color:#1f2a33",
  "  classDef empty fill:#f6f7f8,stroke:#9aa5ae,color:#4a545c",
];

/** The engine's verdict on one Course, with the one case the engine
 * cannot answer handled here.
 *
 * `checkCourse` returns SAT for a code it has never heard of — it reads
 * `catalog[code]`, finds nothing, and has no requirements to fail. That
 * is right for the engine's own question and catastrophic as a diagram:
 * a Course this Edition does not carry would be painted green and
 * labelled satisfied, which is the ESC 410 shape (DECISIONS.md §2.4)
 * rendered in colour. A code we cannot find is a question we cannot
 * answer, so it reads "cannot be checked". */
function statusOf(cat: Catalog, it: PlanItem, sched: Schedule): EvalValue {
  if (!cat[it.code!]) return UNK;
  return checkCourse(cat, it.code!, it.sem, sched).value;
}

function courseLabel(cat: Catalog, plan: PlanDoc, it: PlanItem, value: EvalValue): string {
  const c = cat[it.code!];
  const title = c?.title ? label(c.title) : label("not in this edition's catalog — unverified");
  const state = overridden(plan, it.code!)
    ? `${STATUS[value]} (adviser override on file)`
    : STATUS[value];
  const done = plan.completed[it.code!] ? "<br/>already completed" : "";
  return `${label(it.code!)}<br/>${title}<br/>${label(state)}${done}`;
}

/** Every prerequisite edge the catalog actually states between two
 * Courses that are both drawn.
 *
 * DERIVED FROM `checkCourse`, NOT FROM A SECOND READING OF THE CATALOG.
 * Its `inplan` leaves are precisely "this Course's prerequisites name
 * that Course, and that Course is in this Plan" — the same leaves the
 * planner's `computeEdges` draws its lines from. Anything else would be
 * a reading of the bulletin the engine did not make, and a reading
 * nobody checked is an invented edge.
 *
 * Three cases are deliberately NOT drawn:
 *
 *  - a prerequisite satisfied by a Course the student already finished
 *    and that is therefore not on the chart. `buildSchedule` registers
 *    those at `sem: -1` with no card; an edge to a box that does not
 *    exist is not a thing Mermaid can draw, and inventing a box for it
 *    would put a completed course into a Term it is not in;
 *  - a prerequisite that is not in the Plan at all (an `external`
 *    leaf). It is real and it is missing, which is the audit's story to
 *    tell and not an edge;
 *  - a Course whose prerequisite structure was never read. `checkCourse`
 *    returns "cannot be checked" with a single phrase leaf for those, so
 *    there is nothing to draw — which is right: no edges is honest, and
 *    the node already says the prerequisites could not be checked. */
function edgesOf(ctx: ToolContext, nodes: Map<string, Node>): string[] {
  const cat: Catalog = ctx.data.catalog;
  const { sched } = ctx;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const node of nodes.values()) {
    const it = node.item;
    if (!cat[it.code!]) continue;
    for (const leaf of checkCourse(cat, it.code!, it.sem, sched).leaves) {
      if (leaf.kind !== "inplan") continue;
      // Through the SCHEDULE, because a prerequisite may be named by an
      // alias, or by the base code of an honors section the student is
      // actually taking (`buildSchedule`). The item is the thing with a
      // box; the code in the bulletin's sentence may not be.
      const source = sched[leaf.code]?.item;
      if (!source || source.sem < 0) continue;
      const from = nodes.get(source.id);
      if (!from || from.id === node.id) continue;

      const key = `${from.id}>${node.id}:${leaf.concurrent}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (leaf.v === UNSAT) {
        out.push(`${from.id} ==>|"scheduled out of order"| ${node.id}`);
      } else if (leaf.concurrent) {
        out.push(`${from.id} -. "same term allowed" .-> ${node.id}`);
      } else {
        out.push(`${from.id} --> ${node.id}`);
      }
    }
  }
  return out;
}
