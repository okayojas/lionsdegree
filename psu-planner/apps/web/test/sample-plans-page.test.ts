/** The Sample plans page's list: what is written into the page, and what
 * typing finds in it (#67).
 *
 * Both halves live in src/site/sample-plans.ts: the build folds each
 * Program's name with the same function the page folds a student's typing
 * with. These are the rules a student meets, stated as what they type and
 * what they get.
 */
import { describe, it, expect } from "vitest";
import { findable, finds, plannerLink, programListHtml, type TemplateEntry } from "../src/site/sample-plans";

const erie: TemplateEntry = { program: "behrend-computer-science-bs", name: "Computer Science, B.S. (Behrend)", campuses: ["Erie Campus"] };
const womens: TemplateEntry = {
  program: "liberal-arts-womens-studies-ba",
  name: "Women's, Gender, and Sexuality Studies, B.A.",
  campuses: ["University Park Campus", "Abington Campus"],
};

describe("what typing finds", () => {
  const found = (entry: TemplateEntry, typed: string) => finds(findable(entry), typed);

  it("finds a Program by any words of its name, in any order and any case", () => {
    expect(found(erie, "computer science")).toBe(true);
    expect(found(erie, "Science COMPUTER")).toBe(true);
    expect(found(erie, "chemistry")).toBe(false);
    // Every word has to be there, not any one of them.
    expect(found(erie, "computer engineering")).toBe(false);
  });

  it("finds a Program by its campus", () => {
    expect(found(erie, "erie")).toBe(true);
    expect(found(erie, "computer erie")).toBe(true);
    expect(found(erie, "computer abington")).toBe(false);
  });

  it("finds it from the start of a word, which is how far a student has typed", () => {
    expect(found(erie, "comp sci")).toBe(true);
    // From the START: "ba" is the B.A.s, not every word with "ba" inside it.
    expect(found(womens, "ba")).toBe(true);
    expect(found({ ...erie, campuses: ["Abington Campus"] }, "ba")).toBe(false);
  });

  it("reads a degree as it is typed, with its full stops or without", () => {
    for (const typed of ["bs", "BS", "b.s.", "B.S"]) expect(found(erie, typed), typed).toBe(true);
    expect(found(erie, "ba")).toBe(false);
  });

  it("does not ask for the apostrophe, or the accent", () => {
    expect(found(womens, "womens")).toBe(true);
    expect(found(womens, "women's")).toBe(true);
    expect(found(womens, "women’s")).toBe(true);
    expect(found({ ...erie, name: "Español, B.A." }, "espanol")).toBe(true);
  });

  it("finds everything when nothing is typed", () => {
    expect(found(erie, "")).toBe(true);
    expect(found(erie, "   ")).toBe(true);
    // Punctuation alone is nothing typed, not a search for nothing.
    expect(found(erie, ",")).toBe(true);
  });
});

describe("the list written into the page", () => {
  it("gives each Program its name, its campuses and a link that opens it in the planner", () => {
    const html = programListHtml([womens]);
    expect(html).toContain(">Women's, Gender, and Sexuality Studies, B.A.</p>");
    expect(html).toContain(">University Park Campus · Abington Campus</p>");
    expect(html).toContain('href="/plan/?programs=liberal-arts-womens-studies-ba"');
  });

  it("names the Program in each link, for someone hearing a list of 383 of them", () => {
    expect(programListHtml([erie])).toMatch(
      /Open in the planner<span class="sr-only">: Computer Science, B\.S\. \(Behrend\)<\/span>/,
    );
  });

  it("says so where the Bulletin names no campus, and does not guess one", () => {
    const html = programListHtml([{ ...erie, campuses: [] }]);
    expect(html).toContain("The Bulletin names no campus for this plan");
    expect(html).not.toContain("Erie");
  });

  it("writes one item per Program, in the order it was given", () => {
    const html = programListHtml([womens, erie]);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.indexOf("Women")).toBeLessThan(html.indexOf("Computer Science"));
  });

  it("cannot be broken out of by a name with markup in it", () => {
    // The names are the Bulletin's, scraped. Nothing scraped is trusted to be
    // text only.
    const html = programListHtml([{ program: 'x"><script>', name: 'Arts & <b>Crafts</b> "B.A."', campuses: ["<i>Here</i>"] }]);
    expect(html).not.toMatch(/<script|<b>|<i>/);
    expect(html).toContain("Arts &amp; &lt;b&gt;Crafts&lt;/b&gt; &quot;B.A.&quot;");
    expect(html).toContain("&lt;i&gt;Here&lt;/i&gt;");
    expect(plannerLink('x"><script>')).toBe("/plan/?programs=x%22%3E%3Cscript%3E");
  });
});
