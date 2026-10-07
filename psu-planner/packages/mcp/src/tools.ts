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
  credOf,
  parsePlanFile,
  progress,
  searchCatalog,
  type Catalog,
  type PlanDoc,
  type PlanItem,
  type Schedule,
} from "@psu-planner/engine";
import { loadEdition, publishedEditions, type EditionCatalog } from "./catalog.js";

export interface ToolContext {
  plan: PlanDoc;
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

export function listTools(): ToolDefinition[] {
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
        "Search Penn State courses by topic or by course code. Returns code, title, credits and General Education designations. Does NOT say whether a course runs in a given semester.",
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
      name: "search_programs",
      description:
        "Search majors, minors and certificates by name. A program offered only at other campuses is still in the catalog; the campuses field says where.",
      inputSchema: obj({ query: str("Program name or part of one"), limit: num("Max results") }, ["query"]),
    },
    {
      name: "audit_requirements",
      description:
        "What each of the student's programs still requires, against what their plan already contains.",
      inputSchema: obj({}),
    },
  ];
}

/** Read the student's plan and the one edition it is pinned to. */
export async function loadContext(opts: { planPath: string; catalogRoot: string }): Promise<ToolContext> {
  const text = await fs.promises.readFile(opts.planPath, "utf-8");
  const editions = publishedEditions(opts.catalogRoot);
  const parsed = parsePlanFile(text, editions);
  if (!parsed.ok) throw new Error(parsed.reason);

  const data = loadEdition(opts.catalogRoot, parsed.plan.edition ?? editions[0]);
  const items = buildItems(parsed.plan, data.catalog);
  return { plan: parsed.plan, planPath: opts.planPath, data, items, sched: buildSchedule(parsed.plan, items, data.catalog) };
}

/** Catalog prose is text the university wrote and we retrieved. Fenced so the
 * assistant treats it as reference material: an unfenced description is a
 * prompt-injection surface (DECISIONS.md 5.0, S4). */
const fence = (text: string) => `<untrusted_catalog_text>${text}</untrusted_catalog_text>`;

const MAX_RESULTS = 25;

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const { plan, data, items, sched } = ctx;
  const cat: Catalog = data.catalog;
  const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";

  switch (name) {
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
      const limit = Math.min(Number(args.limit ?? 10) || 10, MAX_RESULTS);
      return searchCatalog(cat, String(args.query ?? ""), limit).map((c) => ({
        code: cat[c].code,
        title: cat[c].title,
        credits: cat[c].credits,
        genEd: cat[c].genEd,
      }));
    }

    case "get_course_details": {
      const c = cat[code];
      if (!c) return { error: `${code || args.code} is not in the ${data.edition} catalog` };
      return {
        code: c.code,
        title: c.title,
        credits: c.credits,
        description: fence(c.description),
        enforced_prerequisites: c.enforced,
        enforced_concurrent: c.concurrent,
        genEd: c.genEd,
        bulletin_url: c.url,
        availability: "Unknown — we cannot see which semesters a course runs. Check LionPATH.",
      };
    }

    case "check_prerequisites": {
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
      if (!cat[code]) return { error: `${code || args.code} is not in the ${data.edition} catalog` };
      const maxDepth = Math.min(Number(args.max_depth ?? 4) || 4, 6);
      const completed = new Set(Object.keys(plan.completed).filter((c) => plan.completed[c]));
      const planned = new Map(items.filter((i) => i.kind === "course").map((i) => [i.code!, i.sem]));
      const missing = new Set<string>();
      const seen = new Set<string>();

      interface Node { code: string; title?: string; status: string; prerequisites?: Node[]; note?: string }
      const walk = (c: string, depth: number): Node => {
        const course = cat[c];
        const status = completed.has(c)
          ? "completed"
          : planned.has(c)
            ? `in plan, ${plan.terms[planned.get(c)!]?.label ?? `term ${planned.get(c)! + 1}`}`
            : "MISSING";
        if (status === "MISSING") missing.add(c);
        const node: Node = { code: c, title: course?.title, status };
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
      return { ...root, missing_from_plan: [...missing].filter((m) => m !== code) };
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
