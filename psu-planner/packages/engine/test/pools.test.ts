/** Pool resolution on REAL catalog data: a Requirement Rule becomes a Pool of
 * one of its kinds, carrying where the knowledge came from.
 *
 * The provenance is the point. A bulletin table is authoritative; a department
 * list read off an off-bulletin page is not; and "ask your adviser" is a real
 * answer rather than missing data. A student has to be told which they are
 * looking at, so the kind travels with the courses. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  codeMatchesPool,
  fingerprintRequirement,
  poolFromRule,
  poolIsAdviserDefined,
  resolveSlotPool,
  type Pool,
  type Registry,
  type ReqRule,
  type ReqSection,
} from "../src/index.js";
import { CATALOG_DIR } from "./edition.js";

const load = (rel: string) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), "utf-8"));
const major = (slug: string) => load(`programs/majors/${slug}.json`);

/** First selectCredits rule in a program whose prose contains `needle`. */
function ruleWhere(slug: string, needle: string): ReqRule & { commentRaw: string } {
  const p = major(slug);
  for (const s of p.requirementSections as ReqSection[]) {
    for (const r of s.rules) {
      if (r.type === "selectCredits" && r.commentRaw.includes(needle)) return r;
    }
  }
  throw new Error(`no selectCredits rule containing "${needle}" in ${slug}`);
}

/** Assert a Pool's kind and narrow to it, so each test reads as one claim. */
function ofKind<K extends Pool["kind"]>(pool: Pool | null, kind: K): Extract<Pool, { kind: K }> {
  expect(pool?.kind).toBe(kind);
  return pool as Extract<Pool, { kind: K }>;
}

describe("a Requirement Rule resolves to a Pool of a known kind", () => {
  it("a requirement that names its courses outright is a listed Pool", () => {
    const pool = ofKind(poolFromRule(ruleWhere("abington-art-ba", "15 credits")), "listed");
    expect(pool.courses).toContain("ART 211");
    expect(pool.courses.length).toBeGreaterThan(5);
  });

  it("a requirement naming subjects and a level is a patterned Pool, keeping every subject", () => {
    const pool = ofKind(poolFromRule(ruleWhere("abington-accounting-bs", "200 - 400 level business courses")), "patterned");
    // The prose names seven subjects; holding only the first silently deleted six.
    expect(pool.subjects).toEqual(expect.arrayContaining(["ACCTG", "BA", "ECON", "FIN", "MGMT", "MKTG", "SCM"]));
    // "200 - 400 level" admits 200-level courses. Reading it as 400 excluded them.
    expect(pool.minLevel).toBe(200);
  });

  it("a General Education requirement is a genEd Pool", () => {
    const pool = ofKind(poolFromRule(ruleWhere("abington-integrative-arts-ba", "Select 6 credits of GA")), "genEd");
    expect(pool.domain).toBe("GA");
  });
});

describe("an Adviser-Defined Requirement", () => {
  const rule = ruleWhere("abington-health-humanities-ba", "In consultation with adviser");

  it("is an adviser Pool carrying the requirement's own wording", () => {
    const pool = ofKind(poolFromRule(rule), "adviser");
    expect(pool.prose).toContain("In consultation with adviser");
  });

  it("is never an empty course list, which would read as 'no course qualifies'", () => {
    const pool = poolFromRule(rule)!;
    expect(pool).not.toHaveProperty("courses");
    expect(codeMatchesPool("ENGL 202C", pool)).toBe(false);
  });
});

describe("a Pool sourced from the Registry", () => {
  const SLUG = "abington-health-humanities-ba";
  const rule = ruleWhere(SLUG, "In consultation with adviser");
  const registry: Registry = {
    entries: [
      {
        entryId: "abington-health-humanities-lvpa",
        programSlug: SLUG,
        edition: "2026-2027",
        fingerprint: fingerprintRequirement((rule as { commentRaw: string }).commentRaw),
        courses: ["ENGL 184", "ART 100", "MUSIC 007"],
        sourceUrl: "https://example.psu.edu/approved-list",
        fetchedAt: "2026-10-06",
        campusScope: "abington",
        confirmedBy: "human",
      },
    ],
  };
  const ctx = { programSlug: SLUG, edition: "2026-2027", registry };

  it("carries its courses and where they were read from", () => {
    const pool = ofKind(poolFromRule(rule, ctx), "registry");
    expect(pool.courses).toContain("ART 100");
    expect(pool.sourceUrl).toBe("https://example.psu.edu/approved-list");
    expect(pool.fetchedAt).toBe("2026-10-06");
    expect(pool.edition).toBe("2026-2027");
    expect(pool.campusScope).toBe("abington");
    expect(pool.confirmedBy).toBe("human");
  });

  it("is only used for the Edition it was read for", () => {
    expect(poolFromRule(rule, { ...ctx, edition: "2025-2026" })?.kind).toBe("adviser");
  });

  it("is only used for the requirement it answers", () => {
    const stale: Registry = {
      entries: [{ ...registry.entries[0], fingerprint: "deadbeef" }],
    };
    // A reworded requirement must fail loud into review, not quietly apply a
    // list that answered the previous wording.
    expect(poolFromRule(rule, { ...ctx, registry: stale })?.kind).toBe("adviser");
  });

  it("does not override a list the bulletin itself publishes", () => {
    const listed = ruleWhere("abington-art-ba", "15 credits");
    const pool = poolFromRule(listed, {
      programSlug: "abington-art-ba",
      edition: "2026-2027",
      registry: {
        entries: [
          {
            ...registry.entries[0],
            programSlug: "abington-art-ba",
            fingerprint: fingerprintRequirement((listed as { commentRaw: string }).commentRaw),
          },
        ],
      },
    });
    expect(pool?.kind).toBe("listed");
  });
});

describe("unreadable is not the same as adviser-defined", () => {
  // Coverage reporting excludes adviser-defined requirements from its
  // denominator because they have no answer by design. A row we simply failed
  // to parse must NOT get that exemption, or the published coverage figure
  // silently inflates by the ~594 unstructured rows in each edition.
  it("a row we could not parse is unreadable, not adviser", () => {
    const dir = path.join(CATALOG_DIR, "programs/majors");
    let checked = 0;
    for (const f of fs.readdirSync(dir)) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      for (const s of (p.requirementSections ?? []) as ReqSection[]) {
        for (const r of s.rules) {
          if (r.type !== "unstructured") continue;
          expect(poolFromRule(r)?.kind).toBe("unreadable");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100); // the corpus really does contain them
  });

  it("only genuinely adviser-defined requirements count as adviser", () => {
    const adviser = poolFromRule(ruleWhere("abington-health-humanities-ba", "In consultation with adviser"));
    expect(poolIsAdviserDefined(adviser)).toBe(true);
    expect(poolIsAdviserDefined({ kind: "unreadable", prose: "whatever" })).toBe(false);
  });

  it("a choice whose options we failed to read does not become an approved list", () => {
    // Previously the sibling-section fallback fired for any pool with no
    // courses, so an unreadable chooseN absorbed the whole section and
    // rendered as an authoritative list. Iron rule 2: unparseable must never
    // present as satisfied.
    const pool = poolFromRule({ type: "chooseN", n: 2, options: [], credits: null, commentRaw: "Select two of the following:" });
    expect(pool?.kind).toBe("unreadable");
  });
});

describe("the engine reads no files", () => {
  it("resolves with no Registry supplied at all", () => {
    expect(poolFromRule(ruleWhere("abington-health-humanities-ba", "In consultation with adviser"))?.kind).toBe("adviser");
  });
});

describe("no Pool is a confident empty list", () => {
  it("across every major, a listed or registry Pool always has at least one course", () => {
    const dir = path.join(CATALOG_DIR, "programs/majors");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      for (const s of (p.requirementSections ?? []) as ReqSection[]) {
        for (const r of s.rules) {
          const pool = poolFromRule(r);
          if (pool && (pool.kind === "listed" || pool.kind === "registry") && pool.courses.length === 0) {
            offenders.push(`${p.slug}: ${s.heading}`);
          }
        }
      }
    }
    expect(offenders.slice(0, 5)).toEqual([]);
  });
});

describe("requirements whose options are indented under them", () => {
  /** Every selectCredits rule in the edition, with its resolved Pool. */
  function allSelectPools(): { slug: string; pool: ReturnType<typeof poolFromRule> }[] {
    const out: { slug: string; pool: ReturnType<typeof poolFromRule> }[] = [];
    for (const kind of ["majors", "minors", "certificates"]) {
      const dir = path.join(CATALOG_DIR, "programs", kind);
      for (const f of fs.readdirSync(dir)) {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        for (const s of (p.requirementSections ?? []) as ReqSection[]) {
          for (const r of s.rules) {
            if (r.type === "selectCredits") out.push({ slug: p.slug, pool: poolFromRule(r) });
          }
        }
      }
    }
    return out;
  }

  it("resolve to a Pool holding those options, not to nothing", () => {
    // A parent comment with its options indented beneath used to lose every
    // course below the first unreadable row. 110 such requirements resolved
    // to nothing; the recoverable ones now carry their courses. The rest
    // genuinely publish no list -- they name topic areas like "American
    // literature" -- and must stay unreadable rather than be invented.
    const pools = allSelectPools();
    expect(pools.length).toBeGreaterThan(2000);
    const unreadable = pools.filter((p) => p.pool?.kind === "unreadable");
    expect(unreadable.length).toBeLessThanOrEqual(90);
  });

  it("do not sweep in the next requirement's courses", () => {
    // Indentation bounds the list. A pool that swallowed its whole section
    // would be far larger than any real published list.
    const huge = allSelectPools().filter(
      (p) => (p.pool?.kind === "listed" || p.pool?.kind === "registry") && p.pool.courses.length > 300,
    );
    // ESM's technical-elective list (227) is the largest legitimate one.
    expect(huge.map((h) => h.slug)).toEqual([]);
  });
});

describe("existing slot fulfilment is unchanged", () => {
  const esc = major("engineering-engineering-science-bs");

  it("the ESC Technical Elective pool still holds the department list", () => {
    const pool = ofKind(resolveSlotPool("Technical Elective", esc.requirementSections), "listed");
    expect(pool.courses.length).toBe(227);
    expect(codeMatchesPool("CMPSC 465", pool)).toBe(true);
  });

  it("the ESC Foundational Elective pool still holds the ESM list", () => {
    const pool = resolveSlotPool("Foundational Elective", esc.requirementSections);
    expect(codeMatchesPool("CMPSC 221", pool)).toBe(true);
    expect(codeMatchesPool("EE 330", pool)).toBe(true);
  });
});

describe("fingerprintRequirement", () => {
  it("ignores whitespace and case, so cosmetic edits do not invalidate an entry", () => {
    expect(fingerprintRequirement("Select 6 credits  from the LIST")).toBe(
      fingerprintRequirement("select 6 credits from the list"),
    );
  });

  it("changes when the requirement actually changes", () => {
    expect(fingerprintRequirement("Select 6 credits")).not.toBe(fingerprintRequirement("Select 9 credits"));
  });
});
