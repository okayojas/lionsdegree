/** Given a course the student looked up, show which OPEN requirement slots it
 * can fill — Gen Ed (category-matched), or Foundational/Technical Elective
 * (matched against the program's published list). If a requirement has no
 * published list, the course can still be placed but is labelled adviser-verify. */
import { useEffect, useState } from "react";
import {
  GENED_BUCKETS, bucketAccepts, codeMatchesPool, poolHasMembership, resolveSlotPool,
  type Course, type ReqSection,
} from "@psu-planner/engine";
import { loadProgramBySlug } from "../data/catalogClient";
import { usePlanner } from "../store";

const GENED_KEYS = new Set(GENED_BUCKETS.map((b) => b.key));
type Row = { id: string; label: string; kind: "ge" | "approved" | "unverified" };

export function SlotFillPicker({ course, onFill }: { course: Course; onFill: (slotId: string, label: string) => void }) {
  const { plan, items } = usePlanner();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const open = items.filter((i) => i.kind === "slot");
      const out: Row[] = [];
      const cache = new Map<string, ReqSection[]>();
      for (const s of open) {
        if (s.slot && GENED_KEYS.has(s.slot)) {
          const bucket = GENED_BUCKETS.find((b) => b.key === s.slot);
          if (bucket && bucketAccepts(bucket, course)) out.push({ id: s.id, label: s.slotLabel ?? bucket.label, kind: "ge" });
        } else if (s.slot === "GE") {
          if (course.genEd.length) out.push({ id: s.id, label: s.slotLabel ?? "General Education", kind: "ge" });
        } else {
          // Elective slot: match against the program's published list, if any.
          let sections = s.slotProgram ? cache.get(s.slotProgram) : undefined;
          if (s.slotProgram && !cache.has(s.slotProgram)) {
            const prog = await loadProgramBySlug<{ requirementSections: ReqSection[] }>(s.slotProgram).catch(() => null);
            sections = prog?.requirementSections ?? [];
            cache.set(s.slotProgram, sections);
          }
          const pool = sections && s.slotLabel ? resolveSlotPool(s.slotLabel, sections) : null;
          if (poolHasMembership(pool)) {
            if (codeMatchesPool(course.code, pool)) out.push({ id: s.id, label: s.slotLabel ?? "Elective", kind: "approved" });
            // On a published list but this course isn't on it → don't offer it.
          } else {
            // No published list — allow the placement but flag it adviser-verify.
            out.push({ id: s.id, label: s.slotLabel ?? "Elective", kind: "unverified" });
          }
        }
      }
      if (alive) setRows(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.code, plan?.rev]);

  if (!rows || !rows.length) return null;
  return (
    <>
      <p className="desc" style={{ marginTop: 12, marginBottom: 4 }}><b>Fill an open requirement slot</b></p>
      <div className="row" style={{ marginTop: 0 }}>
        {rows.map((r) => (
          <button
            key={r.id}
            className={r.kind === "unverified" ? undefined : "primary"}
            onClick={() => onFill(r.id, r.label)}
            title={
              r.kind === "unverified" ? "No published list for this requirement — confirm with your adviser that it counts"
              : r.kind === "approved" ? "On this requirement's approved list"
              : "Qualifies for this Gen Ed category"
            }
          >
            {r.kind === "unverified" ? `Use for ${r.label} · verify w/ adviser` : `Fill ${r.label}`}
          </button>
        ))}
      </div>
    </>
  );
}
