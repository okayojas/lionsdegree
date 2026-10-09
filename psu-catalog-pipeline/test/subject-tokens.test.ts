/** Subject tokens in requirement prose.
 *
 * Penn State writes some subject codes with an internal space -- "PL SC
 * courses" is PLSC in the catalog -- so reading only the first half leaves
 * the requirement with no pool at all, because PL is not a subject. Widening
 * the token to allow a second word is easy; keeping it from eating ordinary
 * English is the hard part, and every case below is a row that actually
 * regressed while this was being got right. */
import { describe, it, expect } from "vitest";
import { parseLevelSubjects } from "../src/parse/programRequirements.js";

const subjectsOf = (prose: string) => parseLevelSubjects(prose)?.subjects ?? null;

describe("a subject code written with a space", () => {
  it("is read as the single subject the catalog stores", () => {
    expect(subjectsOf("400 level PL SC courses")).toEqual(["PLSC"]);
    expect(subjectsOf("Select 6 credits of 400-level PL SC courses")).toEqual(["PLSC"]);
  });

  it("is read even when a parenthetical sits between the count and the subject", () => {
    // behrend-politics-government-minor. This exact row shipped in two
    // editions as "we couldn't read this requirement's course list".
    expect(subjectsOf("Select 12 credits (at least 6 credits at the 400 level) from PL SC courses")).toEqual(["PLSC"]);
  });
});

describe("ordinary prose is not a subject", () => {
  it("does not glue a following Capitalised word onto a real subject", () => {
    // "Advanced IT Business courses" read as "IT B" -> ITB, which is not a
    // subject, so integrity dropped it and destroyed the valid IT with it.
    const s = subjectsOf("400-level Advanced IT Business courses");
    expect(s).toContain("IT");
    expect(s).not.toContain("ITB");
  });

  it("does not absorb a wildcard placeholder", () => {
    // "NURS 400-Level ... (NURS XXX)" became NURSXXX.
    const s = subjectsOf("NURS 400-Level courses (NURS XXX)");
    expect(s).not.toContain("NURSXXX");
    expect(s).toContain("NURS");
  });

  it("still reads a plain one-word subject", () => {
    expect(subjectsOf("Select 12 credits (at least 6 credits at the 400 level) from HIST courses")).toEqual(["HIST"]);
  });
});

describe("the token is a live regex", () => {
  /** The two-word branch spent two sessions "mysteriously" not matching, and
   * the cause was two literal U+0008 bytes where \b had been typed: a shell
   * heredoc ate the backslash. A regex corrupted that way matches nothing and
   * looks exactly like one that works, so assert the branch fires rather than
   * trusting that the source reads correctly. */
  it("matches the two-word form at all", () => {
    expect(subjectsOf("400 level PL SC courses")).not.toEqual(["PL"]);
  });
});
