/** The tools a student's assistant can call.
 *
 * READ-ONLY. Nothing here writes to the plan file. Mutating tools are a
 * separate piece of work, and shipping one early would let an assistant
 * change a plan the student never agreed to expose to writes.
 *
 * The dispatcher is the seam this is tested at. Protocol framing belongs to
 * the SDK and testing it would assert a library rather than this behaviour. */
import fs from "node:fs";
import {
  astCourses,
  auditProgram,
  buildItems,
  buildPool,
  buildSchedule,
  checkCourse,
  discover,
  fenceCatalogText,
  credOf,
  parsePlanFile,
  progress,
  majorDeptPrefixes,
  rankSlotPicks,
  resolveSlotPool,
  subjectOf,
  type Pool,
  searchCatalog,
  type Catalog,
  type PlanDoc,
  type PlanItem,
  type Schedule,
} from "@psu-planner/engine";
import { loadEdition, type EditionCatalog } from "./catalog.js";
import { FsCatalogSource, type CatalogSource } from "./source.js";
import { executeMutation } from "./mutations.js";

export interface ToolContext {
  /** Mutable: a write refreshes these so the next call sees the new plan.
   *
   * NULL on the hosted connector's catalog-only surface (#33), where
   * there is no student signed in yet and the tools answer about the
   * Bulletin rather than about anyone's degree. Tools that need a Plan
   * refuse by name rather than reaching into it — see CATALOG_ONLY. */
  plan: PlanDoc | null;
  planPath: string;
  data: EditionCatalog;
  items: PlanItem[];
  sched: Schedule;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/** The tools that answer from the Bulletin alone.
 *
 * AN ALLOWLIST, DELIBERATELY, and the inversion is the whole point. The
 * first version listed the Plan-shaped tools instead and missed three of
 * the seven mutations — `fill_slot`, `add_term` and `skip_term` were
 * advertised on the unauthenticated endpoint, which the live deploy
 * showed and no test did.
 *
 * Getting a denylist wrong exposes a tool. Getting an allowlist wrong
 * hides one. A new tool is Plan-shaped until someone says otherwise, and
 * the cost of forgetting is a missing feature rather than a student's
 * degree reachable without an account.
 *
 * `mcp-surface.test.ts` asserts every mutation is outside this set, read
 * from `executeMutation`'s own cases so the two cannot drift. */
export const CATALOG_ONLY: ReadonlySet<string> = new Set([
  "search_catalog",
  "get_course_details",
  "get_prereq_chain",
  "search_programs",
  "discover_programs",
]);

/** Does this tool need a student's Plan? Everything not named above. */
export const needsPlan = (name: string): boolean => !CATALOG_ONLY.has(name);

export function listTools(opts: { catalogOnly?: boolean } = {}): ToolDefinition[] {
  const all = allTools();
  return opts.catalogOnly ? all.filter((t) => CATALOG_ONLY.has(t.name)) : all;
}

function allTools(): ToolDefinition[] {
  return [
    {
      name: "get_plan",
      description:
        "The student's degree plan: every term, the courses in it, the open requirement slots, and which bulletin edition governs it. Call this first — every other answer depends on what is already planned.",
      inputSchema: obj({}),
    },
    {
      name: "search_catalog",
      description:
        "Search Penn State courses by topic or by course code. Returns code, title, credits and General Education designations. Does NOT say whether a course runs in a given term.",
      inputSchema: obj({ query: str("A topic or a course code"), limit: num("Max results, up to 25") }, ["query"]),
    },
    {
      name: "get_course_details",
      description:
        "Everything known about one course: description, enforced prerequisites, General Education designations, and its bulletin link.",
      inputSchema: obj({ code: str('Course code, e.g. "MATH 141"') }, ["code"]),
    },
    {
      name: "check_prerequisites",
      description:
        "Whether the student's plan satisfies a course's prerequisites by a given term, with the reason for each part.",
      inputSchema: obj(
        { code: str("Course code"), term_index: num("0-based term in the plan") },
        ["code"],
      ),
    },
    {
      name: "get_prereq_chain",
      description:
        "The whole prerequisite tree for a course in ONE call, each node marked completed, in-plan or missing. Use this instead of walking prerequisites step by step.",
      inputSchema: obj({ code: str("Course code"), max_depth: num("How deep to walk, up to 6") }, ["code"]),
    },
    {
      name: "discover_programs",
      description:
        "Turn an interest described in plain words into combinations of REAL Penn State credentials — a major with a minor and a certificate that reuse each other's coursework. Returns the credits that count toward more than one of them. Use this when the student says what they are interested in rather than naming a program; use search_programs when they already know the name. Returns nothing when the catalog has no match, which means say so rather than inventing a combination.",
      inputSchema: obj(
        { interest: str('What the student is into, in their words — "machine learning and clean energy"') },
        ["interest"],
      ),
    },
    {
      name: "search_programs",
      description:
        "Search majors, minors and certificates by name. A program offered only at other campuses is still in the catalog; the campuses field says where.",
      inputSchema: obj({ query: str("Program name or part of one"), limit: num("Max results") }, ["query"]),
    },
    {
      name: "suggest_slot_courses",
      description:
        "Ranked courses that can fill one open requirement slot, in the same order the planner shows. Courses whose prerequisites the plan already satisfies come first.",
      inputSchema: obj({ slot_id: str("A slot_id from get_plan") }, ["slot_id"]),
    },
    {
      name: "add_course",
      description: "Add a course to a term in the plan.",
      inputSchema: obj({ code: str("Course code"), term_index: num("0-based term") }, ["code", "term_index"]),
    },
    {
      name: "remove_course",
      description:
        "Remove a course from the plan. A course the student's degree REQUIRES is refused unless they have asked for it in their own words — never solve a scheduling conflict this way, use set_schedule_constraint instead.",
      inputSchema: obj(
        {
          code: str("Course code"),
          user_explicitly_asked: {
            type: "boolean",
            description:
              "Only true when the student has said, in their own words, that they want this course out of their degree. Never infer it.",
          },
        },
        ["code"],
      ),
    },
    {
      name: "set_schedule_constraint",
      description:
        "How to answer \"I can't take X next spring\". Keeps the course in the degree and re-flows the schedule around the constraint, which survives every future optimize.",
      inputSchema: obj(
        {
          code: str("Course code"),
          rule: str('"not-in" (not that term), "not-before" (no earlier than), or "pin" (exactly there)'),
          term_index: num("0-based term"),
        },
        ["code", "rule", "term_index"],
      ),
    },
    {
      name: "optimize_schedule",
      description:
        "Repack the whole plan into the fewest full-time terms in ONE call, honouring prerequisites, the credit cap and every constraint. Use this for any 'graduate sooner / consolidate' request rather than moving courses one at a time.",
      inputSchema: obj({ target_terms: num("Optional: aim for exactly this many terms") }),
    },
    {
      name: "fill_slot",
      description: "Choose a course for an open requirement slot. Refused if the course is not on that requirement's approved list.",
      inputSchema: obj({ slot_id: str("A slot_id from get_plan"), code: str("Course code") }, ["slot_id", "code"]),
    },
    {
      name: "add_term",
      description: "Append an empty term to the end of the plan.",
      inputSchema: obj({}),
    },
    {
      name: "skip_term",
      description:
        "Mark a term as intentionally empty — a gap year, co-op or leave. Coursework re-flows around it and graduation moves back; nothing is removed.",
      inputSchema: obj({ term_index: num("0-based term") }, ["term_index"]),
    },
    {
      name: "audit_requirements",
      description:
        "What each of the student's programs still requires, against what their plan already contains.",
      inputSchema: obj({}),
    },
  ];
}

/** Read the student's Plan and the one Edition it is pinned to.
 *
 * `catalogRoot` still works and still means a directory on disk; passing a
 * `source` instead is what lets the hosted connector reuse every line of
 * this without a second implementation. */
export async function loadContext(opts: {
  planPath: string;
  catalogRoot?: string;
  source?: CatalogSource;
}): Promise<ToolContext> {
  const source = opts.source ?? new FsCatalogSource(opts.catalogRoot!);
  const text = await fs.promises.readFile(opts.planPath, "utf-8");
  const editions = await source.editions();
  const parsed = parsePlanFile(text, editions);
  if (!parsed.ok) throw new Error(parsed.reason);

  const data = await loadEdition(source, parsed.plan.edition ?? editions[0]);

  // THE LOAD THAT MAKES PREREQUISITES ANSWERABLE. The audit index carries
  // no prerequisite structure, so every Course arrives as `astComplete:
  // false` -- which correctly reports "could not be checked" rather than
  // "satisfied", and would do so for the student's entire Plan. Reading
  // the subject files behind the Plan's own Courses, plus one hop into
  // what their prerequisites name, is what turns that into real answers.
  // It is the Plan's subjects, not the catalog: a dozen files, not 527.
  await data.ensureCourses(planCodes(parsed.plan));

  const items = buildItems(parsed.plan, data.catalog);
  return { plan: parsed.plan, planPath: opts.planPath, data, items, sched: buildSchedule(parsed.plan, items, data.catalog) };
}

/** Every Course code a Plan mentions, including ones it has removed or
 * pinned into a slot -- all of them end up on the chart or in the audit. */
function planCodes(plan: PlanDoc): string[] {
  const out: string[] = [];
  for (const term of plan.terms ?? []) {
    for (const spec of term.items ?? []) {
      const code = (spec as { code?: string }).code;
      if (code) out.push(code);
    }
  }
  for (const added of plan.added ?? []) if (added.code) out.push(added.code);
  for (const code of Object.values(plan.slotFills ?? {})) if (code) out.push(code);
  for (const code of Object.keys(plan.completed ?? {})) if (code) out.push(code);
  return out;
}

/** Catalog prose reaching a model is fenced so it reads as reference data and
 * never as instruction (DECISIONS.md 5.0, S4). Descriptions are no longer
 * published at all, so the remaining prose is an adviser-defined or unreadable
 * requirement's own words -- see suggest_slot_courses. Implementation is shared
 * with the web chat in the engine; a second copy of a security boundary drifts
 * from the first. */

const MAX_RESULTS = 25;

/** Load enough subject files for a prerequisite walk `depth` levels deep.
 *
 * `ensureCourses` follows one hop, which is right for the Plan's own
 * Courses. A chain tool walks further than that, and an unloaded level
 * would come back with no `prereqAst` and silently look like the end of
 * the chain -- a shorter tree presented as a complete one, which is the
 * confident-wrong-answer shape (iron rule 2). Bounded by `depth`, which
 * the caller already caps at 6.
 */
async function hydrateChain(data: EditionCatalog, root: string, depth: number): Promise<void> {
  let frontier = [root];
  const seen = new Set<string>([root]);
  for (let d = 0; d <= depth && frontier.length; d++) {
    await data.ensureCourses(frontier);
    const next: string[] = [];
    for (const c of frontier) {
      const ast = data.catalog[c]?.prereqAst;
      if (!ast) continue;
      for (const k of astCourses(ast)) {
        if (!seen.has(k)) {
          seen.add(k);
          next.push(k);
        }
      }
    }
    frontier = next;
  }
}

/** The subjects a slot's pool could draw from, so their prerequisite
 * structure is read before candidates are ranked on readiness.
 *
 * A `genEd` pool draws from the whole catalog and is deliberately absent.
 * The audit index already carries gen-ed designations, so matching still
 * works; what degrades is `prerequisites_met`, which reports false for a
 * Course whose structure was never read. That is understated rather than
 * wrong, and loading 527 files to improve it would undo the whole change.
 */
function poolSubjects(pool: Pool | null): string[] {
  if (!pool) return [];
  if (pool.kind === "listed" || pool.kind === "registry") return pool.courses.map(subjectOf);
  if (pool.kind === "patterned") return pool.subjects;
  // `genEd` and anything added later: no bounded subject set to read.
  return [];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  // Mutations live in their own module: their rules are about not losing a
  // student's work, which is a different concern from answering well.
  const mutated = await executeMutation(name, args, ctx);
  if (mutated) return mutated;

  const { data, items, sched } = ctx;

  // The line between "about the Bulletin" and "about you". On the hosted
  // catalog surface there is no Plan, and a tool that needs one says so
  // instead of reaching into null — which is a stack trace where an
  // explanation belongs.
  if (needsPlan(name) && !ctx.plan) {
    return {
      error:
        `${name} needs your plan, and this connector is not signed in to an account yet. ` +
        `Course, prerequisite and program questions work without one.`,
    };
  }
  // Safe past the guard above: every case below that reads `plan` is in
  // NEEDS_PLAN, which the e2e asserts.
  const plan = ctx.plan as PlanDoc;
  const cat: Catalog = data.catalog;
  const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";

  switch (name) {
    case "suggest_slot_courses": {
      const slot = items.find((i) => i.kind === "slot" && i.id === String(args.slot_id ?? ""));
      if (!slot) return { error: `no open slot with id ${args.slot_id} — call get_plan for current slot ids` };
      const prog = slot.slotProgram ? data.programs[slot.slotProgram] : undefined;
      const pool = prog && slot.slotLabel ? resolveSlotPool(slot.slotLabel, prog.requirementSections) : null;
      // Ranking scores candidates partly on whether their prerequisites are
      // met, which needs their structure read. Bounded: a listed pool names
      // its Courses and a patterned one names its subjects.
      await data.ensureSubjects(poolSubjects(pool));
      const ranked = rankSlotPicks(cat, pool, {
        exclude: new Set(items.filter((i) => i.kind === "course").map((i) => i.code!)),
        majorPrefixes: majorDeptPrefixes(plan),
        needUS: false,
        needIL: false,
        sched,
        termIndex: slot.sem,
        limit: 15,
      });
      return {
        requirement: slot.slotLabel ?? slot.slot,
        // An adviser-defined or unreadable pool has no list, so its note
        // QUOTES the bulletin -- the requirement's own words are the answer.
        // That makes this the catalog prose that still reaches a model now
        // that descriptions are not published, so it is the thing that now
        // needs fencing. Our own phrasings ("From this requirement's
        // published list") are not fenced: marking our words untrusted
        // teaches the model to discount them.
        what_counts:
          pool?.kind === "adviser" || pool?.kind === "unreadable"
            ? fenceCatalogText(ranked.poolNote)
            : ranked.poolNote,
        availability: ranked.offeringsNote,
        picks: ranked.picks.map((p) => ({
          code: p.course.code,
          title: p.course.title,
          credits: p.course.credits,
          prerequisites_met: p.ready,
          also: p.bonuses,
        })),
        ...(ranked.searchHint ? { search_instead_for: ranked.searchHint } : {}),
      };
    }

    case "get_plan": {
      const prog = progress(plan, items, cat);
      return {
        edition: data.edition,
        edition_note:
          "Requirements come from the bulletin edition in force when the student entered their major. This plan follows " +
          `${data.edition}.`,
        programs: plan.programs,
        credits: { completed: prog.done, planned_total: prog.total },
        completed_courses: Object.keys(plan.completed).filter((c) => plan.completed[c]),
        terms: plan.terms.map((t, i) => ({
          index: i,
          label: t.label,
          credits: items.filter((it) => it.sem === i).reduce((sum, it) => sum + credOf(it, cat), 0),
          courses: items
            .filter((it) => it.sem === i && it.kind === "course")
            .map((it) => ({
              code: it.code,
              title: cat[it.code!]?.title ?? "(not in this edition's catalog — unverified)",
              prerequisites: checkCourse(cat, it.code!, it.sem, sched).value === 2 ? "satisfied" : "check",
            })),
          open_slots: items
            .filter((it) => it.sem === i && it.kind === "slot")
            .map((it) => ({ slot_id: it.id, kind: it.slot, label: it.slotLabel, credits: it.credits })),
        })),
      };
    }

    case "search_catalog": {
      // The 7.8 MB of ranking data, fetched the first time somebody
      // actually searches. Without it search still works on code and title,
      // so this is a quality step rather than a correctness one -- but it
      // is the difference between finding "robotics" by name and finding it
      // by what the Course is about.
      await data.ensureSearchRanking();
      const limit = Math.min(Number(args.limit ?? 10) || 10, MAX_RESULTS);
      // The Edition's OWN ranking, passed explicitly. It used to come
      // from engine module state, which one isolate serving two Editions
      // would have crossed.
      return searchCatalog(cat, String(args.query ?? ""), limit, data.ranking).map((c) => ({
        code: cat[c].code,
        title: cat[c].title,
        credits: cat[c].credits,
        genEd: cat[c].genEd,
      }));
    }

    case "get_course_details": {
      // Keywords, the bulletin URL and the prerequisite text all live in
      // the subject file, not the audit index -- without this the tool
      // would answer with empty strings for every one of them.
      await data.ensureCourses([code]);
      const c = cat[code];
      if (!c) return { error: `${code || args.code} is not in the ${data.edition} catalog` };
      return {
        code: c.code,
        title: c.title,
        credits: c.credits,
        // Keywords first: extracted topic terms are facts about the course
        // and need no fencing. The description is the University's prose and
        // does, and is excerpted rather than reproduced whole.
        // Keywords, not prose. Extracted terms are facts about the course and
        // need no fencing; the Bulletin's description is not published here at
        // all (DECISIONS.md 5.1), so bulletin_url is where the text lives.
        keywords: c.keywords ?? [],
        enforced_prerequisites: c.enforced,
        enforced_concurrent: c.concurrent,
        genEd: c.genEd,
        bulletin_url: c.url,
        availability: "Unknown — we cannot see which terms a course runs. Check LionPATH.",
      };
    }

    case "check_prerequisites": {
      // One hop is enough here: the check reads THIS Course's prerequisite
      // tree and asks whether each leaf is in the schedule, never what
      // those leaves themselves require.
      await data.ensureCourses([code]);
      if (!cat[code]) return { error: `${code || args.code} is not in the ${data.edition} catalog` };
      const term = Number(args.term_index ?? 0);
      const chk = checkCourse(cat, code, term, sched);
      return {
        code,
        term_index: term,
        term_label: plan.terms[term]?.label ?? `term ${term}`,
        // "unknown" is NOT "satisfied": the requirement is free text we could
        // not evaluate, and presenting it as met would be a confident wrong
        // answer about whether a student can register.
        result: chk.value === 2 ? "satisfied" : chk.value === 1 ? "cannot determine — verify with an adviser" : "NOT satisfied",
        details: chk.leaves.map((l) =>
          l.kind === "phrase"
            ? { requirement: l.text, status: "not machine-checkable — verify manually" }
            : { course: l.code, status: l.v === 2 ? "ok" : l.v === 1 ? "unknown" : "missing or too late" },
        ),
      };
    }

    case "get_prereq_chain": {
      const maxDepth = Math.min(Number(args.max_depth ?? 4) || 4, 6);
      await hydrateChain(data, code, maxDepth);
      if (!cat[code]) return { error: `${code || args.code} is not in the ${data.edition} catalog` };
      // THE CHAIN IS A BULLETIN FACT; the statuses are a fact about one
      // student. So the chain answers with or without a Plan, and only
      // the annotations go missing — "what does MATH 230 require" is
      // exactly the question the hosted connector exists for, and
      // refusing it for want of an account would be refusing the easy
      // half because the hard half is absent.
      const hasPlan = ctx.plan !== null;
      const completed = new Set(
        hasPlan ? Object.keys(plan.completed).filter((c) => plan.completed[c]) : [],
      );
      const planned = new Map(items.filter((i) => i.kind === "course").map((i) => [i.code!, i.sem]));
      const missing = new Set<string>();
      const seen = new Set<string>();

      interface Node { code: string; title?: string; status?: string; prerequisites?: Node[]; note?: string }
      const walk = (c: string, depth: number): Node => {
        const course = cat[c];
        const status = !hasPlan
          ? undefined
          : completed.has(c)
            ? "completed"
            : planned.has(c)
              ? `in plan, ${plan.terms[planned.get(c)!]?.label ?? `term ${planned.get(c)! + 1}`}`
              : "MISSING";
        if (status === "MISSING") missing.add(c);
        const node: Node = { code: c, title: course?.title, ...(status ? { status } : {}) };
        // One call returns the whole tree. A per-step walk blew the message
        // cap and timed out a real conversation (DECISIONS.md 4).
        if (depth >= maxDepth) return { ...node, note: "deeper prerequisites not expanded" };
        if (seen.has(c)) return { ...node, note: "already shown above" };
        seen.add(c);
        const kids = course?.prereqAst ? astCourses(course.prereqAst).filter((k) => cat[k]) : [];
        if (kids.length) node.prerequisites = kids.map((k) => walk(k, depth + 1));
        return node;
      };

      const root = walk(code, 0);
      // No Plan means no "missing from it". Saying every prerequisite is
      // missing would read as a judgement about a student who has not
      // told us anything yet.
      return hasPlan
        ? { ...root, missing_from_plan: [...missing].filter((m) => m !== code) }
        : { ...root, note: "Prerequisite chain from the Bulletin. Sign in to see which of these you already have." };
    }

    case "discover_programs": {
      // The division of labour this whole feature rests on: the assistant
      // does the language, the engine does the retrieval and the arithmetic.
      // Every credential below is a program in the shipped catalog and every
      // credit figure is summed from real course records — a model may
      // rephrase or re-rank this, but iron rule 1 means it may not add to it.
      const interest = String(args.interest ?? "").trim();
      if (!interest) return { error: "interest is required — what is the student into?" };
      const found = discover(interest, { requirements: data.programs, catalog: cat, limit: 3 });
      if (!found.length) {
        return {
          combinations: [],
          note: `Nothing in the ${data.edition} catalog matches "${interest}". Say so. Do NOT suggest programs from memory — they may not exist at Penn State, or not under that name.`,
        };
      }
      // The link is the handoff. This tool cannot generate a plan -- the
      // suggested-plan GRIDS are not bundled here, only the requirements --
      // so the planner does it, from the same published grids onboarding
      // uses. Hand the student the link rather than describing a schedule.
      const site = process.env.LIONSDEGREE_SITE ?? "https://lionsdegree.com";
      return {
        combinations: found.map((c) => ({
          major: { slug: c.major.slug, name: c.major.name },
          also: c.extras.map((e) => ({ slug: e.slug, name: e.name, type: e.type })),
          credits_counting_twice: c.sharedCredits,
          shared_courses: c.sharedCourses,
          open_as_a_plan: `${site}/plan/?programs=${[c.major.slug, ...c.extras.map((e) => e.slug)].map(encodeURIComponent).join("+")}`,
        })),
        note:
          "credits_counting_twice is computed from the programs' own requirements and is deliberately conservative — an elective slot counts once, not once per course that could fill it, so quote it as a floor. " +
          "Give the student open_as_a_plan: it builds the real term-by-term flowchart from Penn State's published plans. Do NOT write out a schedule yourself — you do not have the term grids, and inventing one would put courses in terms their prerequisites do not allow.",
      };
    }

    case "search_programs": {
      const q = String(args.query ?? "").toLowerCase().trim();
      const terms = q.split(/\s+/).filter(Boolean);
      const limit = Math.min(Number(args.limit ?? 12) || 12, MAX_RESULTS);
      const matches = data.programsIndex
        .map((p) => {
          const name = p.name.toLowerCase();
          let score = name.includes(q) && q ? 10 : 0;
          for (const t of terms) if (name.includes(t)) score += 2;
          return { p, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ p }) => ({ slug: p.slug, name: p.name, type: p.type, campuses: p.campuses, college: p.college }));
      return {
        matches,
        note: "campuses lists where each program is offered. A program offered only at other campuses IS in the catalog — say which campus offers it rather than that it does not exist.",
      };
    }

    case "audit_requirements": {
      const pool = buildPool(plan, cat);
      return {
        edition: data.edition,
        programs: plan.programs.map((slug) => {
          const prog = data.programs[slug];
          if (!prog) return { slug, error: `not in the ${data.edition} catalog` };
          const audit = auditProgram(prog.requirementSections, pool, cat, data.coveredBy);
          return { slug, name: prog.name, total_credits: prog.totalCredits, audit };
        }),
        note: "An item reported as unknown is one we could not evaluate, not one that is satisfied.",
      };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
