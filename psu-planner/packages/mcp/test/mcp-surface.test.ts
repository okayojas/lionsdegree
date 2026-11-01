/** What the connector offers without an account.
 *
 * THE BUG THIS EXISTS FOR. The split was first written as a list of
 * Plan-shaped tools to EXCLUDE, and it missed three of the seven
 * mutations — `fill_slot`, `add_term` and `skip_term` were advertised on
 * the unauthenticated endpoint. The live deploy showed it; no test did.
 *
 * So the classification is now an allowlist, and this file checks it
 * against the server's own definitions rather than against a second
 * hand-written list that could be wrong in the same way.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_ONLY, HOSTED_TOOLS, listTools, needsPlan, READABLE_PLAN_TOOLS } from "../src/tools.js";
import { MUTATIONS } from "../src/mutations.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every tool `executeMutation` handles, read from the source.
 *
 * Derived rather than restated: a hand-kept copy of this list is exactly
 * what went wrong, and a mutation added next year must not need anyone
 * to remember this file. */
function mutatingTools(): string[] {
  const src = fs.readFileSync(path.join(here, "..", "src", "mutations.ts"), "utf-8");
  const body = src.slice(src.indexOf("export async function executeMutation"));
  return [...body.matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]).sort();
}

describe("the catalog-only surface", () => {
  it("offers nothing that can change a student's Plan", () => {
    // The assertion that matters. Everything else here is hygiene.
    const mutations = mutatingTools();
    expect(mutations.length, "no mutations were found — the scan is broken, not the surface").toBeGreaterThan(5);
    const leaked = mutations.filter((m) => CATALOG_ONLY.has(m));
    expect(leaked, "a tool that writes to a Plan is offered without an account").toEqual([]);
  });

  it("offers nothing that reads a student's Plan", () => {
    for (const planShaped of ["get_plan", "audit_requirements", "check_prerequisites", "suggest_slot_courses"]) {
      expect(CATALOG_ONLY.has(planShaped), `${planShaped} is offered without an account`).toBe(false);
    }
  });

  it("does offer the Bulletin questions, or the connector is pointless", () => {
    const names = listTools({ offer: CATALOG_ONLY }).map((t) => t.name);
    expect(names.sort()).toEqual(
      ["discover_programs", "get_course_details", "get_prereq_chain", "search_catalog", "search_programs"].sort(),
    );
  });

  it("treats an unknown tool as needing a Plan", () => {
    // The direction the allowlist exists to fix: something nobody
    // classified is hidden, not exposed.
    expect(needsPlan("some_tool_added_next_year")).toBe(true);
  });

  it("still offers everything when a Plan is present", () => {
    const all = listTools().map((t) => t.name);
    for (const m of mutatingTools()) expect(all, `${m} vanished from the full surface`).toContain(m);
    expect(all.length).toBeGreaterThan(CATALOG_ONLY.size);
  });

  it("dispatches exactly the mutations it declares", () => {
    // `executeMutation` returns null for anything outside `MUTATIONS`,
    // so a case in the switch that nobody added to the set is dead code
    // that falls through to the read surface — and a name in the set
    // with no case is a tool that silently does nothing.
    expect([...MUTATIONS].sort()).toEqual(mutatingTools());
  });
});

/** What a SIGNED-IN student is offered (#35).
 *
 * The same bug as above, one surface along. The hosted list was first
 * written as four names typed out by hand — and there are seven
 * mutations, so three of them were one edit away from being advertised
 * to a model that could then call them. Derived here, from the server's
 * own definitions, for exactly the reason the catalog surface is.
 */
describe("the hosted surface", () => {
  it("offers nothing that can change a student's Plan", () => {
    // THE ASSERTION THAT MATTERS. Reads went hosted in #35; writes wait
    // for #36, and a write offered before then is a model editing a
    // degree plan a student is also editing in another window.
    const leaked = mutatingTools().filter((m) => HOSTED_TOOLS.has(m));
    expect(leaked, "a tool that writes to a Plan is offered on the hosted connector").toEqual([]);
  });

  it("offers every Plan tool that only reads", () => {
    for (const r of READABLE_PLAN_TOOLS) {
      expect(HOSTED_TOOLS.has(r), `${r} is not offered to a signed-in student`).toBe(true);
    }
  });

  it("is the catalog tools plus those reads, and nothing else", () => {
    // Anything not in one of the two named sets is unclassified, and
    // unclassified must mean hidden rather than exposed.
    const names = listTools({ offer: HOSTED_TOOLS }).map((t) => t.name).sort();
    expect(names).toEqual([...new Set([...CATALOG_ONLY, ...READABLE_PLAN_TOOLS])].sort());
  });

  it("still answers the Bulletin questions without touching a Plan", () => {
    for (const c of CATALOG_ONLY) expect(HOSTED_TOOLS.has(c), `${c} was dropped`).toBe(true);
  });
});
