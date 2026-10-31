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
import { CATALOG_ONLY, listTools, needsPlan } from "../src/tools.js";

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
    const names = listTools({ catalogOnly: true }).map((t) => t.name);
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
});
