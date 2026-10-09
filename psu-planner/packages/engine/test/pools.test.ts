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
    // 90 in both published editions: the 86 whose option tables genuinely
    // cannot be read, plus the 4 whose every named subject turned out not to
    // exist. Those 4 used to be filed as adviser-defined, which exempted a
    // parse failure from the coverage denominator. It was 5 until the
    // two-word subject token started working and PL SC became readable.
    //
    // The bound is a RATCHET -- it may fall when more are recovered, and a
    // rise means something regressed.
    expect(unreadable.length).toBeLessThanOrEqual(90);
  });

  it("hold each course once, because a Pool is a set", () => {
    const repeated = allSelectPools()
      .filter((p) => p.pool?.kind === "listed" || p.pool?.kind === "registry")
      .filter((p) => {
        const c = (p.pool as { courses: string[] }).courses;
        return new Set(c).size !== c.length;
      });
    expect(repeated.map((m) => m.slug)).toEqual([]);
  });

  it("do not merge two mutually exclusive branches into one list", () => {
    // Real regression: the Spanish certificate offers one list to students who
    // took SPAN 215N and a different one to students who took SPAN 253W. Both
    // branch headers are indented under a shared heading, so leaving the list
    // open across them merged 5 + 13 courses into one pool and offered a
    // student courses that cannot satisfy their requirement. A size threshold
    // would never have caught it -- the merged pool was only 18 courses.
    const p = JSON.parse(
      fs.readFileSync(
        path.join(CATALOG_DIR, "programs/certificates/liberal-arts-global-spanish-business-certificate.json"),
        "utf-8",
      ),
    );
    const branches = (p.requirementSections as ReqSection[])
      .flatMap((s) => s.rules)
      .filter((r) => r.type === "chooseN" && r.commentRaw.startsWith("If you take"));
    expect(branches.length).toBe(2);
    const [a, b] = branches.map((r) => poolFromRule(r));
    const aCourses = (a as { courses: string[] }).courses;
    const bCourses = (b as { courses: string[] }).courses;
    expect(aCourses.length).toBeLessThan(10);
    expect(aCourses.some((c) => bCourses.includes(c) && !aCourses.includes(c))).toBe(false);
    // The shared heading above them absorbs neither branch.
    const header = (p.requirementSections as ReqSection[])
      .flatMap((s) => s.rules)
      .find((r) => r.type === "selectCredits" && r.commentRaw.includes("Culture Course Lists"));
    expect(ofKind(poolFromRule(header!), "unreadable")).toBeTruthy();
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

describe("an empty course list stays unreadable", () => {
  /** It is tempting to fall back to the section's other courses when a
   * "Select N credits of the following:" header comes back with an empty
   * list. All ten such rules in the shipped catalog were checked by hand and
   * none of them recovers correctly: the siblings are separately-required
   * courses, a different concentration's branch, or prose the parser mistook
   * for a course code. The honest answer is "we could not read this". */
  const prog = (rel: string) => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, rel), "utf-8"));

  it("does not offer separately-required courses as if they were the elective list", () => {
    // The certificate requires SPAN 310 and SPAN 420 outright. Offering them
    // as the "Culture Course Lists" elective would let one course satisfy two
    // requirements and graduate a student three credits short.
    const cert = prog("programs/certificates/liberal-arts-global-spanish-business-certificate.json");
    const section = (cert.requirementSections as ReqSection[])[0];
    const rule = section.rules.find(
      (r) => r.type === "selectCredits" && r.commentRaw.includes("Culture Course Lists"),
    ) as { commentRaw: string; from: { courses: string[] } };
    expect(rule, "the Spanish culture-list case is missing from the catalog").toBeDefined();
    expect(rule.from.courses, "fixture assumes this list is empty").toEqual([]);

    const pool = resolveSlotPool(rule.commentRaw, [section]);
    expect(pool?.kind).toBe("unreadable");
    const offered = (pool as { courses?: string[] }).courses ?? [];
    expect(offered).not.toContain("SPAN 310");
    expect(offered).not.toContain("SPAN 420");
  });

  it("never offers prose that was mistaken for a course code", () => {
    // earth-sciences section 2 carries sibling rows whose "codes" are
    // "SELECT 8" and "APPLY 6". Whatever a slot offers, it must not be those.
    const es = prog("programs/majors/earth-mineral-sciences-earth-sciences-bs.json");
    const section = (es.requirementSections as ReqSection[])[2];
    const rule = section.rules.find(
      (r) => r.type === "selectCredits" && r.from?.kind === "courses" && !r.from.courses.length,
    ) as { commentRaw: string } | undefined;
    expect(rule, "the earth-sciences case is missing from the catalog").toBeDefined();

    const pool = resolveSlotPool(rule!.commentRaw, [section]);
    for (const junk of (pool as { courses?: string[] }).courses ?? []) {
      expect(junk, "prose leaked into a pool as a course code").toMatch(/^[A-Z]{2,8}(-[A-Z])? ?\d/);
      expect(junk.split(" ")[0]).not.toMatch(/^(SELECT|APPLY|LEAST|THE|OF)$/);
    }
  });
});
