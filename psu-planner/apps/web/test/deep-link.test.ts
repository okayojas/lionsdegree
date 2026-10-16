/** `/plan/?programs=…` — the handoff from an assistant to the planner.
 *
 * The query string is text someone else wrote, and in the case this exists
 * for, "someone else" is a language model. A slug it invented must never
 * reach a fetch, and a slug it got wrong must never be silently dropped from
 * a plan the student was told they were getting.
 */
import { describe, it, expect } from "vitest";
import { parseProgramLink, programLink } from "../src/data/deepLink.js";

const known = new Set(["ai-methods-bs", "energy-business-minor", "building-ai-certificate"]);

describe("reading a program link", () => {
  it("is nothing at all when there is no request", () => {
    // The ordinary case. A student opening the planner normally must not be
    // routed through any of this.
    expect(parseProgramLink("", known)).toBeNull();
    expect(parseProgramLink("?theme=dark", known)).toBeNull();
    expect(parseProgramLink("?programs=", known)).toBeNull();
    expect(parseProgramLink("?programs=%20%20", known)).toBeNull();
  });

  it("reads several programs, in the order given", () => {
    const got = parseProgramLink("?programs=ai-methods-bs+energy-business-minor", known);
    expect(got?.slugs).toEqual(["ai-methods-bs", "energy-business-minor"]);
    expect(got?.unknown).toEqual([]);
  });

  it("separates a slug the catalog does not have, rather than fetching it", () => {
    // The failure this guards: a model that found nothing names a plausible
    // program anyway. It must not become a network request, and it must not
    // vanish — the student was promised three credentials.
    const got = parseProgramLink("?programs=ai-methods-bs+quantum-sorcery-bs", known);
    expect(got?.slugs).toEqual(["ai-methods-bs"]);
    expect(got?.unknown).toEqual(["quantum-sorcery-bs"]);
  });

  it("reports an entirely invented request instead of an empty plan", () => {
    const got = parseProgramLink("?programs=quantum-sorcery-bs", known);
    expect(got?.slugs).toEqual([]);
    expect(got?.unknown).toEqual(["quantum-sorcery-bs"]);
  });

  it("drops duplicates", () => {
    const got = parseProgramLink("?programs=ai-methods-bs+ai-methods-bs", known);
    expect(got?.slugs).toEqual(["ai-methods-bs"]);
  });

  it("caps how many it will act on", () => {
    // Each slug costs a program fetch and the query string is
    // attacker-controlled. Nobody is enrolled in nine credentials.
    const many = Array.from({ length: 40 }, (_, i) => `made-up-${i}`).join("+");
    const got = parseProgramLink(`?programs=${many}`, known);
    expect((got!.slugs.length + got!.unknown.length)).toBeLessThanOrEqual(6);
  });

  it("accepts the separators a link survives being pasted with", () => {
    for (const sep of ["+", "%20", ",", "%2C"]) {
      const got = parseProgramLink(`?programs=ai-methods-bs${sep}energy-business-minor`, known);
      expect(got?.slugs, `separator "${sep}" did not parse`).toEqual([
        "ai-methods-bs",
        "energy-business-minor",
      ]);
    }
  });

  it("round-trips what programLink builds", () => {
    const slugs = ["ai-methods-bs", "energy-business-minor"];
    const url = programLink("https://lionsdegree.com", slugs);
    expect(url).toBe("https://lionsdegree.com/plan/?programs=ai-methods-bs+energy-business-minor");
    expect(parseProgramLink(new URL(url).search, known)?.slugs).toEqual(slugs);
  });

  it("does not care about a trailing slash on the origin", () => {
    expect(programLink("https://lionsdegree.com/", ["a"])).toBe("https://lionsdegree.com/plan/?programs=a");
  });
});
