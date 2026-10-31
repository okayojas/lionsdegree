/** Toolbar search over the full catalog (lazily loaded on first focus). */
import { useEffect, useRef, useState } from "react";
import { qterms, searchCatalog, snippet, type Catalog, type Course } from "@psu-planner/engine";
import { loadSearchCatalog } from "../data/catalogClient";
import { usePlanner } from "../store";

export function SearchBox({ onPick }: { onPick: (course: Course) => void }) {
  const items = usePlanner((s) => s.items);
  const [full, setFull] = useState<Catalog | null>(null);
  const [loadingPct, setLoadingPct] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const boxRef = useRef<HTMLDivElement>(null);

  const ensureFull = async () => {
    if (full || loadingPct !== null) return;
    // Indeterminate rather than a percentage: this is now two fetches, one
    // of which is usually already resolved, so a progress number would be
    // mostly 0 and then 100. The spinner says "working", which is all a
    // sub-second wait can honestly claim.
    setLoadingPct(0);
    const cat = await loadSearchCatalog();
    setFull(cat);
    setLoadingPct(null);
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const run = (query: string, cat: Catalog | null) => {
    if (!cat || !query.trim()) { setHits([]); setShow(!!query.trim()); return; }
    setHits(searchCatalog(cat, query));
    setShow(true);
  };

  const onChange = (v: string) => {
    setQ(v);
    void ensureFull();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(v, full), 140);
  };

  useEffect(() => {
    if (full && q.trim()) run(q, full);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  const stems = qterms(q);

  return (
    <div className="searchbox" ref={boxRef}>
      <input
        placeholder={loadingPct !== null ? `Loading catalog… ${loadingPct}%` : "Search courses by code or description"}
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { void ensureFull(); if (q.trim()) setShow(true); }}
        // Width lives in the stylesheet (`.searchbox input`), not here. As an
        // inline style it beat every rule including the phone one, so the
        // field stayed 330px wide inside an 18px box and pushed the document
        // 100px sideways.
      />
      <div className={`search-results${show ? " show" : ""}`}>
        {q.trim() && hits.length === 0 && (
          <div className="sr-empty">
            {full ? "No matches in the PSU catalog. Try other words or an exact code like “CMPSC 465”." : "Loading the catalog…"}
          </div>
        )}
        {hits.map((k) => {
          const c = full![k];
          const inPlan = items.some((x) => x.kind === "course" && x.code === k);
          const snip = snippet(c.description ?? "", stems);
          return (
            <div key={k} className="sr-item" onMouseDown={(e) => { e.preventDefault(); setShow(false); onPick(c); }}>
              <div className="sr-code">
                {c.display}
                {inPlan && <span className="inplan">in your plan</span>}
                <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11 }}> · {c.credits}</span>
              </div>
              <div className="sr-title">{c.title}</div>
              <div className="sr-snip">
                {snip.ranges.length === 0
                  ? snip.text
                  : snip.ranges.reduce<{ nodes: React.ReactNode[]; pos: number }>(
                      (acc, [s, e], i) => {
                        acc.nodes.push(snip.text.slice(acc.pos, s), <mark key={i}>{snip.text.slice(s, e)}</mark>);
                        acc.pos = e;
                        return acc;
                      },
                      { nodes: [], pos: 0 },
                    ).nodes.concat(snip.text.slice(snip.ranges[snip.ranges.length - 1][1]))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
