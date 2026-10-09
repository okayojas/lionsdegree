/** Client-side tool executors. The model calls these by name; they run against
 * the student's LOCAL plan via the store — the server never holds plan state.
 * Every executor returns a JSON-serializable result the model can read. */
import {
  GENED_BUCKETS, astCourses, auditGenEd, auditHonors, auditProgram, bucketAccepts, buildPool,
  checkCourse, codeMatchesPool, countableCourses, credOf, majorDeptPrefixes, poolHasMembership,
  progress, rankGenEdPicks, rankSlotPicks, resolveSlotPool, searchCatalog,
  type Catalog, type ReqSection, type ScheduleConstraint,
} from "@psu-planner/engine";
import { auditIug } from "@psu-planner/engine";
import { loadCourse, loadCoverage, loadFullCatalog, loadIug, loadIugIndex, loadProgramBySlug, loadProgramsIndex } from "../data/catalogClient";
import { usePlanner } from "../store";
import { appendAction, getActions } from "./ledger";

type ToolResult = unknown;

/** Per-turn guard state: reset by useChat at the start of every user turn.
 * Bulk removals were the failure mode of a real incident — the model deleted
 * a required course plus a pile of electives to "consolidate". */
let removalsThisTurn = 0;
export function resetTurnGuards(): void {
  removalsThisTurn = 0;
}

/** Record a plan mutation to the durable ledger (revBefore captured by caller). */
function record(tool: string, summary: string, revBefore: number | null) {
  appendAction({ tool, summary, planRevBefore: revBefore, planRevAfter: usePlanner.getState().plan?.rev ?? null });
}

async function fullCatalog() {
  return loadFullCatalog();
}

function state() {
  return usePlanner.getState();
}

function requireCode(code: unknown): string {
  if (typeof code !== "string" || !code.trim()) throw new Error("missing course code");
  return code.trim().toUpperCase();
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const s = state();
  const plan = s.plan;
  if (!plan) return { error: "no plan exists yet — the student must complete onboarding first" };

  switch (name) {
    case "get_plan": {
      const { items, sched, catalog } = s;
      const terms = plan.terms.map((t, i) => ({
        index: i,
        label: t.label,
        ...(t.phase === "grad" ? { phase: "graduate (IUG master's)" } : {}),
        credits: items.filter((it) => it.sem === i).reduce((sum, it) => sum + credOf(it, catalog), 0),
        courses: items
          .filter((it) => it.sem === i && it.kind === "course")
          .map((it) => {
            const chk = checkCourse(catalog, it.code!, it.sem, sched);
            return {
              code: it.code,
              title: catalog[it.code!]?.title ?? "(not in catalog — unverified)",
              status: chk.value === 2 ? "ok" : chk.value === 1 ? "warn" : "bad",
              alternatives: it.alternatives?.length ? it.alternatives : undefined,
            };
          }),
        open_slots: items
          .filter((it) => it.sem === i && it.kind === "slot")
          .map((it) => ({ slot_id: it.id, kind: it.slot, label: it.slotLabel, credits: it.credits })),
      }));
      const prog = progress(plan, s.items, s.catalog);
      return {
        programs: plan.programs,
        terms,
        completed_courses: Object.keys(plan.completed).filter((c) => plan.completed[c]),
        credits: { completed: prog.done, total_planned: prog.total },
        schedule_constraints: (plan.constraints ?? []).map((c) => ({
          course: c.code, rule: c.type, term_index: c.termIndex,
          term_label: plan.terms[c.termIndex]?.label ?? `term ${c.termIndex}`,
        })),
      };
    }

    case "search_catalog": {
      const cat = await fullCatalog();
      const q = String(args.query ?? "");
      const limit = Math.min(Number(args.limit ?? 10), 25);
      return searchCatalog(cat, q, limit).map((code) => {
        const c = cat[code];
        return { code: c.code, display: c.display, title: c.title, credits: c.credits, genEd: c.genEd };
      });
    }

    case "search_programs": {
      // Majors / minors / certificates — a SEPARATE corpus from courses. Without
      // this the model has no way to answer "is there a mechatronics minor" and
      // wrongly concludes it isn't in the catalog. A program that exists only at
      // other campuses is STILL in the catalog; the campuses field says where.
      const index = await loadProgramsIndex();
      const q = String(args.query ?? "").toLowerCase().trim();
      const typeFilter = String(args.type ?? "").toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = index
        .filter((p) => (typeFilter === "major" || typeFilter === "minor" || typeFilter === "certificate" ? p.type === typeFilter : true))
        .map((p) => {
          const name = p.name.toLowerCase();
          let score = 0;
          if (name.includes(q) && q) score += 10;
          for (const t of terms) if (name.includes(t)) score += 2;
          return { p, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(Number(args.limit ?? 12), 25));
      return {
        matches: scored.map(({ p }) => ({ slug: p.slug, name: p.name, type: p.type, campuses: p.campuses, college: p.college })),
        note: "campuses lists where each program is offered. If a program is offered only at campuses other than the student's, it IS in the catalog — say which campus offers it, do not say it doesn't exist.",
      };
    }

    case "get_course_details": {
      const cat = await fullCatalog();
      const code = requireCode(args.code);
      // The search index holds a shortened description; a request for the
      // DETAILS of one course is exactly the on-demand case that should read
      // the full text from its subject file.
      // loadCourse THROWS on a non-OK response (it only returns null when the
      // subject is absent from the index), so `??` alone does not cover a 404
      // or a dropped connection. The already-loaded catalog answers the
      // question less fully but correctly; failing the whole tool call because
      // one subject file was unreachable is the worse trade.
      const fetched = await loadCourse(code).catch(() => null);
      const c = fetched ?? cat[code];
      if (!c) return { error: `${args.code} is not in the PSU catalog` };
      return {
        code: c.code, display: c.display, title: c.title, credits: c.credits,
        // Catalog prose is untrusted retrieved data — fence it so the model
        // treats it as reference text, never as instructions (S4 prompt-injection).
        description: `<untrusted_catalog_text>${c.description.slice(0, 900)}</untrusted_catalog_text>`,
        enforced_prerequisites: c.enforced, enforced_concurrent: c.concurrent,
        genEd: c.genEd, bulletin_url: c.url,
      };
    }

    case "check_prerequisites": {
      const code = requireCode(args.code);
      const sem = Number(args.semester_index ?? 0);
      const cat = await fullCatalog();
      if (!cat[code]) return { error: `${code} is not in the catalog` };
      const chk = checkCourse({ ...s.catalog, [code]: cat[code] }, code, sem, s.sched);
      return {
        code, semester_index: sem,
        result: chk.value === 2 ? "satisfied" : chk.value === 1 ? "depends-on-external (verify)" : "VIOLATED",
        details: chk.leaves.map((l) =>
          l.kind === "phrase"
            ? { requirement: l.text, status: "verify manually" }
            : { course: l.code, status: l.v === 2 ? "ok" : l.v === 1 ? "unknown" : "too late/missing", in_plan: l.kind === "inplan" },
        ),
      };
    }

    case "add_course": {
      const code = requireCode(args.code);
      const sem = Number(args.semester_index ?? 0);
      if (sem < 0 || sem >= plan.terms.length) return { error: `semester_index must be 0..${plan.terms.length - 1}` };
      const cat = await fullCatalog();
      if (!cat[code]) return { error: `${code} is not in the catalog — search first` };
      if (s.items.some((it) => it.kind === "course" && it.code === code)) return { error: `${code} is already in the plan` };
      const rev = plan.rev;
      s.mutatePlan((p) => { p.added.push({ code, sem }); });
      await s.refreshCatalog();
      record("add_course", `added ${code} to ${plan.terms[sem].label}`, rev);
      return { ok: true, added: code, to: plan.terms[sem].label };
    }

    case "move_course": {
      const code = requireCode(args.code);
      const sem = Number(args.semester_index ?? 0);
      const item = s.items.find((it) => it.kind === "course" && it.code === code);
      if (!item) return { error: `${code} is not in the plan` };
      if (sem < 0 || sem >= plan.terms.length) return { error: `semester_index must be 0..${plan.terms.length - 1}` };
      const rev = plan.rev;
      s.mutatePlan((p) => { p.moves[item.id] = sem; });
      record("move_course", `moved ${code} to ${plan.terms[sem].label}`, rev);
      return { ok: true, moved: code, to: plan.terms[sem].label };
    }

    case "remove_course": {
      const code = requireCode(args.code);
      const item = s.items.find((it) => it.kind === "course" && it.code === code);
      if (!item) return { error: `${code} is not in the plan` };
      // GUARDS (from a real incident where required courses were deleted to
      // dodge a scheduling conflict). Confirmation for a required course is now
      // USER-attested, not MODEL-attested (S4): the tool refuses to mutate a
      // template course and returns needs_user_confirmation — a poisoned course
      // description can no longer talk the model into a destructive edit.
      // 1. A scheduling conflict is NEVER solved by removal.
      // 2. Required (template) courses require a real user click to remove.
      // 3. At most ONE removal per turn.
      if (removalsThisTurn >= 1) {
        return { error: "removal limit reached for this turn — removing courses is almost never what the student wants. If this is a scheduling conflict, use set_schedule_constraint + optimize_schedule instead." };
      }
      const isTemplateCourse = plan.terms.some((t) => t.items.some((it2) => !("slot" in it2) && it2.code === code && it2.origin));
      if (isTemplateCourse) {
        // Do NOT mutate. The student confirms with a real click on the card.
        return {
          status: "needs_user_confirmation",
          course: code,
          reason: `${code} is a required course from the student's degree template. For safety it can only be removed by a real click, not by the assistant. Tell the student to open ${code} on the flowchart and press "Remove from plan" (they'll get a confirmation). If this is a timing conflict, offer set_schedule_constraint + optimize_schedule instead. Do NOT claim it was removed.`,
        };
      }
      const rev = plan.rev;
      s.removeItem(item.id);
      removalsThisTurn++;
      record("remove_course", `removed ${code} from the plan`, rev);
      return { ok: true, removed: code, note: "restorable from the toolbar" };
    }

    case "set_schedule_constraint": {
      const code = requireCode(args.code);
      const type = String(args.constraint ?? "") as ScheduleConstraint["type"];
      const termIndex = Number(args.term_index);
      if (!["not-in", "not-before", "pin"].includes(type)) return { error: "constraint must be one of: not-in, not-before, pin" };
      if (!Number.isInteger(termIndex) || termIndex < 0 || termIndex >= plan.terms.length + 4) {
        return { error: `term_index must be 0..${plan.terms.length - 1} (call get_plan for term labels)` };
      }
      if (!s.items.some((it) => it.kind === "course" && it.code === code)) return { error: `${code} is not in the plan` };
      const rev = plan.rev;
      s.mutatePlan((p) => {
        p.constraints = (p.constraints ?? []).filter((c) => !(c.code === code && c.type === type && c.termIndex === termIndex));
        p.constraints.push({ code, type, termIndex });
      });
      const label = plan.terms[termIndex]?.label ?? `term ${termIndex}`;
      record("set_schedule_constraint", `constraint: ${code} ${type} ${label}`, rev);
      return {
        ok: true, constraint: { course: code, rule: type, term: label },
        next_step: "call optimize_schedule to rebuild the plan around this constraint — the course moves to its best legal semester and nothing gets removed",
      };
    }

    case "clear_schedule_constraint": {
      const code = requireCode(args.code);
      const before = plan.constraints?.length ?? 0;
      const rev = plan.rev;
      s.mutatePlan((p) => { p.constraints = (p.constraints ?? []).filter((c) => c.code !== code); });
      const cleared = before - (usePlanner.getState().plan?.constraints?.length ?? 0);
      if (cleared > 0) record("clear_schedule_constraint", `cleared ${cleared} constraint(s) on ${code}`, rev);
      return { ok: true, cleared };
    }

    case "add_summer_session": {
      const year = Math.round(Number(args.year));
      if (!Number.isFinite(year) || year < 2020 || year > 2040) return { error: "year must be a calendar year, e.g. 2027" };
      const rev = plan.rev;
      const idx = s.addSummerSession(year);
      if (idx < 0) return { error: "no plan to add a summer session to" };
      record("add_summer_session", `added Summer ${year} session (term index ${idx})`, rev);
      return {
        ok: true, summer: `Summer ${year}`, term_index: idx,
        note: "summer sessions hold at most 9 credits and are exempt from the full-time floor",
        next_step: "call optimize_schedule to let the plan use the new summer capacity (this usually shortens the calendar); or move_course / a pin constraint places a specific course there",
      };
    }

    case "add_semester": {
      const rev = plan.rev;
      const idx = s.addSemester();
      if (idx < 0) return { error: "no plan to add a semester to" };
      record("add_semester", `added an empty semester at index ${idx}`, rev);
      return {
        ok: true, term_index: idx,
        note: "empty semester appended; move or add courses into it. If left empty it's trimmed on the next optimize_schedule.",
      };
    }

    case "delete_semester": {
      const idx = Math.round(Number(args.term_index));
      if (!Number.isFinite(idx) || !plan.terms[idx]) return { error: "term_index must be a valid semester index from get_plan" };
      if (plan.terms[idx].phase === "grad") return { error: "graduate (IUG) terms can't be skipped" };
      const label = plan.terms[idx].label;
      const rev = plan.rev;
      const summary = await s.deleteSemester(idx); // marks it a gap + re-optimizes around it
      record("delete_semester", `skipped ${label} as a gap semester — ${summary.slice(0, 120)}`, rev);
      return { ok: true, skipped: label, summary, note: "the semester is kept EMPTY (a gap year/leave); courses moved to later terms and nothing was removed" };
    }

    case "restore_semester": {
      const idx = Math.round(Number(args.term_index));
      if (!Number.isFinite(idx) || !plan.terms[idx]) return { error: "term_index must be a valid semester index from get_plan" };
      const label = plan.terms[idx].label;
      const rev = plan.rev;
      const summary = await s.restoreSemester(idx);
      record("restore_semester", `un-skipped ${label}`, rev);
      return { ok: true, restored: label, summary };
    }

    case "list_iug_programs": {
      const all = await loadIugIndex();
      const mine = all.filter((e) => e.pairsWith.some((sl) => plan.programs.includes(sl)));
      return {
        available_for_this_student: mine.map((e) => ({ slug: e.slug, degree: e.gradDegree, college: e.college, campus: e.campus })),
        note: mine.length ? "attach_iug with a slug to add one" : "No IUG in our catalog pairs with this student's major(s) yet (only a few are structured so far).",
        all_structured: all.map((e) => ({ slug: e.slug, degree: e.gradDegree, pairs_with: e.pairsWith })),
      };
    }

    case "attach_iug": {
      const slug = String(args.slug ?? "");
      if (!slug) return { error: "missing IUG slug — call list_iug_programs first" };
      const rev = plan.rev;
      const summary = await s.attachIugNow(slug);
      record("attach_iug", `attached IUG ${slug}`, rev);
      const { plan: p2, catalog } = state();
      const spec = await loadIug(slug);
      const audit = p2 && spec ? auditIug(p2, spec, catalog) : null;
      return { ok: true, summary, double_counted: audit?.doubleCounted ?? [], grad_courses_planned: audit?.gradCoursesPlanned ?? [], notes: audit?.notes ?? [] };
    }

    case "detach_iug": {
      const rev = plan.rev;
      const summary = await s.detachIugNow();
      record("detach_iug", "detached IUG", rev);
      return { ok: true, summary };
    }

    case "get_action_history": {
      const limit = Math.min(Number(args.limit ?? 20), 100);
      const entries = getActions(limit);
      return {
        note: "This is the authoritative, persistent record of every plan change made through chat tools. NEVER contradict it.",
        actions: entries.map((e) => ({ when: e.ts, tool: e.tool, what: e.summary })),
      };
    }

    case "fill_slot": {
      const slotId = String(args.slot_id ?? "");
      const code = requireCode(args.code);
      const slot = s.items.find((it) => it.kind === "slot" && it.id === slotId);
      if (!slot) return { error: `no open slot with id ${slotId} — call get_plan for slot ids` };
      const cat = await fullCatalog();
      if (!cat[code]) return { error: `${code} is not in the catalog` };
      // Gen-ed slots are category-typed: reject a course that doesn't carry the
      // required attribute, and hand back efficient picks instead.
      const bucket = GENED_BUCKETS.find((b) => b.key === slot.slot);
      if (bucket && !bucketAccepts(bucket, cat[code])) {
        const prefixes = majorDeptPrefixes(plan);
        const audit = auditGenEd(countableCourses(plan), cat, prefixes);
        const picks = rankGenEdPicks(cat, bucket.key, {
          majorPrefixes: prefixes, needUS: audit.us.remaining, needIL: audit.il.remaining,
          exclude: new Set(s.items.filter((i) => i.kind === "course").map((i) => i.code!)),
        }).slice(0, 5).map((p) => ({ code: p.course.code, title: p.course.title, bonuses: p.bonuses }));
        return {
          error: `${code} does not carry the ${bucket.key} attribute this slot requires (${bucket.label})`,
          efficient_picks: picks,
          note: "picks flagged 'also fulfills IL/US' cover two requirements with one course",
        };
      }
      // ELECTIVE slots were ungated here. A gen-ed slot checked its bucket
      // above, but an elective slot accepted any course in the catalog, so the
      // assistant could fill a Technical Elective with something that does not
      // count toward it -- which the course card itself would have refused.
      if (!bucket && slot.slotProgram && slot.slotLabel) {
        const prog = await loadProgramBySlug<{ requirementSections: ReqSection[] }>(slot.slotProgram);
        const slotPool = prog ? resolveSlotPool(slot.slotLabel, prog.requirementSections) : null;
        if (poolHasMembership(slotPool) && !codeMatchesPool(code, slotPool)) {
          const ranked = rankSlotPicks(cat, slotPool, {
            exclude: new Set(s.items.filter((i) => i.kind === "course").map((i) => i.code!)),
            majorPrefixes: majorDeptPrefixes(plan),
            needUS: false, needIL: false, limit: 5,
          });
          return {
            error: `${code} is not on the approved list for ${slot.slotLabel}`,
            approved_picks: ranked.picks.map((p) => ({ code: p.course.code, title: p.course.title })),
            note: ranked.offeringsNote,
          };
        }
      }
      const revFill = plan.rev;
      s.mutatePlan((p) => { p.slotFills[slotId] = code; });
      await s.refreshCatalog();
      record("fill_slot", `filled slot ${slotId} with ${code}`, revFill);
      return { ok: true, filled: slotId, with: code };
    }

    case "mark_complete": {
      const code = requireCode(args.code);
      const rev = plan.rev;
      s.markCompleted(code, Boolean(args.done));
      record("mark_complete", `marked ${code} ${args.done ? "completed" : "not completed"}`, rev);
      return { ok: true, code, done: Boolean(args.done) };
    }

    case "get_prereq_chain": {
      const code = requireCode(args.code);
      const maxDepth = Math.min(Number(args.max_depth ?? 4), 6);
      const cat = await fullCatalog();
      if (!cat[code]) return { error: `${code} is not in the catalog` };
      const completed = new Set(Object.keys(plan.completed).filter((c) => plan.completed[c]));
      const planned = new Map(s.items.filter((i) => i.kind === "course").map((i) => [i.code!, i.sem]));
      const needed = new Set<string>();
      const visited = new Set<string>();
      let nodes = 0;

      const statusOf = (c: string) =>
        completed.has(c) ? "completed" : planned.has(c) ? `in-plan (semester ${planned.get(c)! + 1})` : "MISSING";

      interface ChainNode {
        code: string; title?: string; status: string;
        enforced_prerequisites?: string | null;
        note?: string;
        prereqs?: ChainNode[];
      }
      const walk = (c: string, depth: number, catRef: Catalog): ChainNode => {
        nodes++;
        const course = catRef[c];
        const node: ChainNode = { code: c, title: course?.title, status: statusOf(c) };
        if (node.status === "MISSING" && c !== code) needed.add(c);
        if (!course) { node.note = "not in catalog — verify manually"; return node; }
        if (course.enforced) node.enforced_prerequisites = course.enforced;
        if (depth >= maxDepth || nodes > 80) {
          if (course.prereqAst) node.note = "depth limit — prerequisites not expanded further";
          return node;
        }
        if (visited.has(c)) { node.note = "already expanded above"; return node; }
        visited.add(c);
        const pre = course.prereqAst ? [...new Set(astCourses(course.prereqAst))] : [];
        if (pre.length) node.prereqs = pre.map((p) => walk(p, depth + 1, catRef));
        return node;
      };
      const tree = walk(code, 0, cat);
      return {
        target: code,
        note: "Prereq strings can contain OR-groups (alternatives) — read each enforced_prerequisites text before assuming ALL listed courses are required.",
        additional_courses_not_completed_or_planned: [...needed],
        count_additional_needed_upper_bound: needed.size,
        tree,
      };
    }

    case "optimize_schedule": {
      // ONE deterministic engine call — the model must never hand-reorder a plan
      // with dozens of move_course calls (that loops until it times out).
      const target = args.semesters == null ? undefined : Math.max(1, Math.round(Number(args.semesters)));
      if (args.semesters != null && !Number.isFinite(Number(args.semesters))) return { error: "semesters must be a number" };
      const revOpt = plan.rev;
      const summary = await s.optimizeNow(target);
      record("optimize_schedule", `re-optimized the plan${target ? ` targeting ${target} semesters` : ""} (${(plan.constraints ?? []).length} constraint(s) honored) — ${summary.slice(0, 140)}`, revOpt);
      const { items, catalog } = state();
      const terms = (state().plan?.terms ?? []).map((t, i) => ({
        index: i,
        label: t.label,
        credits: items.filter((it) => it.sem === i).reduce((sum, it) => sum + credOf(it, catalog), 0),
        courses: items.filter((it) => it.sem === i && it.kind === "course").map((it) => it.code),
        open_slots: items.filter((it) => it.sem === i && it.kind === "slot").length,
      }));
      return { ok: true, summary, semesters: terms.length, terms };
    }

    case "audit_requirements": {
      const cat = await fullCatalog();
      const coveredBy = await loadCoverage();
      const pool = buildPool(plan, cat);
      const out: Record<string, unknown> = {};
      if (plan.iug) {
        const spec = await loadIug(plan.iug.slug);
        const ia = spec ? auditIug(plan, spec, cat) : null;
        if (ia) out["integrated_masters_iug"] = {
          degree: ia.gradDegree, total_grad_credits: ia.totalGradCredits,
          double_counted: ia.doubleCounted, double_count_credits: ia.doubleCountCredits, max: ia.maxDoubleCount,
          grad_courses_planned: ia.gradCoursesPlanned, notes: ia.notes,
        };
      }
      if (plan.honors) {
        const h = auditHonors(plan, cat);
        out["schreyer_honors_college"] = {
          admit_cohort: `year-${plan.honors.admit} admit`,
          credit_windows: h.windows,
          rcl_sequence: h.rcl,
          thesis: h.thesis,
          notes: h.notes,
        };
      }
      for (const slug of plan.programs) {
        const prog = await loadProgramBySlug<{ name: string; requirementSections: ReqSection[] }>(slug);
        if (!prog) { out[slug] = { error: "program data not found" }; continue; }
        const audit = auditProgram(prog.requirementSections, pool, cat, coveredBy);
        out[slug] = {
          name: prog.name,
          totals: audit.totals,
          sections: audit.sections.map((sec) => ({
            heading: sec.heading,
            satisfied_or_in_progress: sec.done,
            still_needed: sec.todo,
            needs_manual_verification: sec.manual,
            open_items: sec.rules.filter((r) => r.status === "todo" || r.status === "partial")
              .map((r) => ({ requirement: r.label, credits_applied: r.creditsApplied, credits_needed: r.creditsNeeded })),
          })),
        };
      }
      return out;
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
