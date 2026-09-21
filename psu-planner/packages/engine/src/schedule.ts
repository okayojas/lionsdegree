/** Plan resolution: PlanDoc -> concrete items + schedule lookup.
 * Port of the demo's buildItems/buildSchedule (L201-237), parameterized on
 * (plan, catalog) instead of globals. */
import type { Catalog, PlanDoc, PlanItem, Schedule } from "./types.js";

function semOf(plan: PlanDoc, id: string, orig: number): number {
  return id in plan.moves ? plan.moves[id] : orig;
}

export function buildItems(plan: PlanDoc, catalog: Catalog): PlanItem[] {
  const items: PlanItem[] = [];
  const removed = plan.removed ?? {};
  plan.terms.forEach((term, i) => {
    term.items.forEach((it) => {
      if (removed["slot" in it ? it.id : it.code]) return;
      if ("slot" in it) {
        const fill = plan.slotFills[it.id];
        if (fill && catalog[fill]) {
          items.push({ id: it.id, kind: "course", code: catalog[fill].code, sem: semOf(plan, it.id, i), fromSlot: it.slot, added: true });
        } else {
          items.push({ id: it.id, kind: "slot", slot: it.slot, slotLabel: it.label, slotProgram: it.program, credits: it.credits, sem: semOf(plan, it.id, i) });
        }
      } else {
        items.push({
          id: it.code,
          kind: "course",
          code: it.code,
          sem: semOf(plan, it.code, i),
          alternatives: it.alternatives,
          unverified: it.unverified,
        });
      }
    });
  });
  plan.added.forEach((a) => {
    if (catalog[a.code] && !items.some((x) => x.kind === "course" && x.code === a.code)) {
      const id = "add-" + a.code;
      items.push({ id, kind: "course", code: a.code, sem: semOf(plan, id, a.sem), added: true });
    }
  });
  return items;
}

/** An honors section (H/M suffix) satisfies its base course's prereq role —
 * MATH 140H stands in wherever a prereq says MATH 140. Register the base code
 * (when the base exists in the catalog) so edges and evaluation keep working
 * after a Schreyer honors upgrade. Never the reverse: a base course does not
 * satisfy an honors-specific prereq. */
function honorsBaseOf(code: string, catalog: Catalog): string | null {
  const m = /^(.* \d+)[HM]$/.exec(code);
  return m && catalog[m[1]] ? m[1] : null;
}

export function buildSchedule(plan: PlanDoc, items: PlanItem[], catalog: Catalog): Schedule {
  const sched: Schedule = {};
  items.forEach((it) => {
    if (it.kind !== "course" || !it.code) return;
    const c = catalog[it.code];
    const entry = { sem: it.sem, completed: !!plan.completed[it.code], item: it };
    (c?.aliases ?? [it.code]).forEach((a) => {
      sched[a] = entry;
    });
    sched[it.code] = entry;
    const base = honorsBaseOf(it.code, catalog);
    if (base && !sched[base]) sched[base] = entry;
  });
  // Courses completed in past semesters are not on the chart (planGen drops
  // them), but they must still satisfy prerequisites. Register them as
  // virtual sem:-1 entries; they have no card, so no edges are drawn to them.
  for (const code of Object.keys(plan.completed)) {
    if (!plan.completed[code] || sched[code]) continue;
    const c = catalog[code];
    const item: PlanItem = { id: "done-" + code, kind: "course", code, sem: -1 };
    const entry = { sem: -1, completed: true, item };
    (c?.aliases ?? [code]).forEach((a) => {
      if (!sched[a]) sched[a] = entry;
    });
    sched[code] = entry;
    const base = honorsBaseOf(code, catalog);
    if (base && !sched[base]) sched[base] = entry;
  }
  return sched;
}

/** Credits contributed by an item (slot credits or first number in the course's credit string). */
export function credOf(it: PlanItem, catalog: Catalog): number {
  if (it.kind === "slot") return Number(it.credits) || 0;
  const c = it.code ? catalog[it.code] : undefined;
  if (!c) return 0;
  if (c.creditsParsed) return c.creditsParsed.min;
  const m = /[\d.]+/.exec(c.credits ?? "");
  return m ? parseFloat(m[0]) : 0;
}

export function progress(plan: PlanDoc, items: PlanItem[], catalog: Catalog): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const inItems = new Set<string>();
  items.forEach((it) => {
    if (it.kind === "course" && it.code) inItems.add(it.code);
    const cr = credOf(it, catalog);
    total += cr;
    if (it.kind === "course" && it.code && plan.completed[it.code]) done += cr;
  });
  // Completed courses removed from the chart still count toward the degree.
  for (const code of Object.keys(plan.completed)) {
    if (!plan.completed[code] || inItems.has(code)) continue;
    const c = catalog[code];
    const cr = c?.creditsParsed ? c.creditsParsed.min : 0;
    done += cr;
    total += cr;
  }
  return { done, total };
}
