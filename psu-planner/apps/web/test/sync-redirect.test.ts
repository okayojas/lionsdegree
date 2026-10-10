/** Where OAuth returns a student.
 *
 * This is one line of code and it was wrong for as long as the build has had
 * two entry points. It is worth a test because the failure is invisible in
 * development until someone actually signs in, and the symptom -- "I logged
 * in and my plan was gone" -- reads like data loss rather than a redirect. */
import { describe, it, expect } from "vitest";
import { signInRedirectTo } from "../src/data/sync";

describe("the OAuth return address", () => {
  it("is the page the student signed in from, not the site root", () => {
    // The planner lives at /plan/ since the build split. Returning to the
    // origin dropped them on the landing page.
    expect(signInRedirectTo({ origin: "https://lionsdegree.com", pathname: "/plan/" }))
      .toBe("https://lionsdegree.com/plan/");
  });

  it("works from the landing page too", () => {
    expect(signInRedirectTo({ origin: "https://lionsdegree.com", pathname: "/" }))
      .toBe("https://lionsdegree.com/");
  });

  it("carries no query or hash into the redirect", () => {
    // Supabase appends its own parameters to this URL. A stale `?` or `#`
    // survives into the redirect and can stop it matching an allow-list
    // entry, which fails as "requested path is invalid" long after the fact.
    const url = signInRedirectTo({ origin: "http://localhost:5173", pathname: "/plan/" });
    expect(url).not.toContain("?");
    expect(url).not.toContain("#");
  });

  it("is a URL an allow-list entry can actually match", () => {
    const url = signInRedirectTo({ origin: "http://localhost:5173", pathname: "/plan/" });
    expect(() => new URL(url)).not.toThrow();
    expect(url.startsWith("http://localhost:5173/")).toBe(true);
  });
});
