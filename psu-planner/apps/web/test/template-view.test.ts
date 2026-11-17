/** A Program's Template as the Sample plans page reads and draws it (#68).
 *
 * Two promises are kept here, before any browser is involved. A file that is
 * not a Template file is refused whole, so the page can say so; it is never
 * drawn as a plan with something missing. And what is drawn is what the file
 * says: a Course is a code, a Slot is the Bulletin's label with nothing put
 * in it.
 */
import { describe, it, expect } from "vitest";
import { creditsText, readTemplates, templateName, templateSummary, termsHtml, type Template } from "../src/site/template-view";

const fall = {
  label: "Year 1 Fall",
  credits: 15,
  entries: [
    { course: "CMPSC 121", credits: 3 },
    { course: "ENGL 15", credits: 3, or: ["ENGL 30H"] },
    { slot: "General Education Course (GN)", credits: 4 },
  ],
};
const template: Template = { label: "Computer Science, B.S. at Erie Campus", credits: 122, terms: [fall] };
const file = { program: "behrend-computer-science-bs", templates: [template] };

/** The text a reader gets from a piece of markup, tags gone. */
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("reading a published Template file", () => {
  it("takes one that is what it should be", () => {
    expect(readTemplates(file, "behrend-computer-science-bs")).toEqual(file);
  });

  it("refuses one that is for another Program", () => {
    // A file served for the wrong Program is somebody else's plan under
    // this Program's name.
    expect(readTemplates(file, "behrend-computer-engineering-bs")).toBeNull();
  });

  it("refuses one with no Template in it, or a Template with no Terms", () => {
    // Never an empty plan: nothing to draw is a failure, said as one.
    expect(readTemplates({ program: "x", templates: [] }, "x")).toBeNull();
    expect(readTemplates({ program: "x", templates: [{ label: "", terms: [] }] }, "x")).toBeNull();
  });

  it("refuses the whole file where any part of it is not a Template", () => {
    const withBadLine = (line: unknown) => ({ program: "x", templates: [{ label: "", terms: [fall, { label: "Year 1 Spring", entries: [line] }] }] });
    // A line that is nothing, a line that is two things, a line with no words.
    expect(readTemplates(withBadLine({ credits: 3 }), "x")).toBeNull();
    expect(readTemplates(withBadLine({ course: "MATH 140", slot: "Elective" }), "x")).toBeNull();
    expect(readTemplates(withBadLine({ slot: "  " }), "x")).toBeNull();
    expect(readTemplates(withBadLine({ course: "MATH 140", credits: "4" }), "x")).toBeNull();
    expect(readTemplates(withBadLine({ course: "MATH 140", or: "MATH 140B" }), "x")).toBeNull();
    // The good line in the Term before it does not save it.
    expect(readTemplates(withBadLine({ course: "MATH 140", credits: 4 }), "x")).not.toBeNull();
  });

  it("refuses what is not a file at all", () => {
    for (const data of [null, undefined, "", "<!doctype html>", 404, [], { program: "x" }, { program: "x", templates: "none" }]) {
      expect(readTemplates(data, "x"), JSON.stringify(data)).toBeNull();
    }
  });

  it("takes the Program's page in the Bulletin, and nothing else as an address", () => {
    const at = (bulletin: unknown) => readTemplates({ ...file, bulletin }, file.program);
    expect(at("https://bulletins.psu.edu/undergraduate/colleges/behrend/computer-science-bs/")?.bulletin).toBe(
      "https://bulletins.psu.edu/undergraduate/colleges/behrend/computer-science-bs/",
    );
    // The page makes a link of it. A file that names anywhere else is not
    // a Template file.
    for (const elsewhere of ["javascript:alert(1)", "https://example.com/", "//bulletins.psu.edu/", "", 7]) {
      expect(at(elsewhere), String(elsewhere)).toBeNull();
    }
  });

  it("takes a note, which is that there is one and no more", () => {
    const noted = (line: unknown) => readTemplates({ program: "x", templates: [{ label: "", terms: [{ label: "Year 1 Fall", entries: [line] }] }] }, "x");
    expect(noted({ note: true })).not.toBeNull();
    expect(noted({ note: "Take PECT exams." })).toBeNull();
    expect(noted({ note: true, slot: "Elective" })).toBeNull();
  });

  it("takes a Term the Bulletin lists nothing for, and a plan it gives no name", () => {
    // Both are in the Bulletin. Neither is a broken file.
    const odd = { program: "x", templates: [{ label: "", terms: [{ label: "Year 1 Fall", credits: 0, entries: [] }, fall] }] };
    expect(readTemplates(odd, "x")).toEqual(odd);
  });
});

describe("a Template's Terms, drawn", () => {
  it("are in the Bulletin's order, each named, with what it adds up to", () => {
    const html = termsHtml({ label: "", terms: [fall, { label: "Year 1 Spring", credits: 15.5, entries: [{ course: "MATH 141", credits: 4 }] }] });
    const headings = [...html.matchAll(/<h3\b[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual(["Year 1 Fall", "Year 1 Spring"]);
    expect(text(html)).toContain("Year 1 Fall 15 credits");
    expect(text(html)).toContain("Year 1 Spring 15.5 credits");
    // An ordered list: the order is the content.
    expect(html).toMatch(/^<ol\b/);
  });

  it("show a Course as its code, with the Courses the Bulletin offers in its place", () => {
    const read = text(termsHtml(template));
    expect(read).toContain("CMPSC 121");
    expect(read).toContain("ENGL 15 or ENGL 30H");
  });

  it("show a Slot as the Bulletin's label, marked as open, with no Course in it", () => {
    const html = termsHtml({ label: "", terms: [{ label: "Year 1 Fall", entries: [{ slot: "General Education Course (GN)", credits: 4 }] }] });
    expect(text(html)).toContain("Open: General Education Course (GN)");
    // The only code-shaped thing in a Term that is one Slot is nothing.
    expect(html).not.toMatch(/\b[A-Z]{2,6} \d{1,3}[A-Z]?\b/);
  });

  it("say so where the plan names a code the Edition's catalog does not have", () => {
    const html = termsHtml({
      label: "",
      terms: [{ label: "Year 2 Spring", entries: [{ unlisted: "LA 283", credits: 1.5 }, { course: "PHYS 211", credits: 4, orUnlisted: ["PHYS 250L"] }] }],
    });
    expect(text(html)).toContain("LA 283 not in this edition's catalog");
    expect(text(html)).toContain("PHYS 211 or PHYS 250L not in this edition's catalog");
  });

  it("give credits in full to a screen reader and in short to the eye", () => {
    const html = termsHtml({ label: "", terms: [{ label: "Year 1 Fall", entries: [{ course: "PSU 7", credits: 1 }, { slot: "Elective" }] }] });
    expect(html).toContain('<span aria-hidden="true">1 cr</span>');
    expect(html).toMatch(/<span\b[^>]*>1 credit<\/span>/);
    // No credits where the Bulletin gives none: not "0", not "undefined".
    expect(text(html)).not.toMatch(/undefined|NaN|\b0 cr/);
  });

  it("say that the Bulletin has a note, and do not make a choice of it", () => {
    const html = termsHtml({ label: "", terms: [{ label: "Year 4 Fall", entries: [{ note: true }, { slot: "Elective", credits: 3 }] }] });
    expect(text(html)).toContain("A note in the Bulletin, not copied here.");
    // "Open:" is said of the Slot and of nothing else.
    expect(text(html).match(/Open:/g)).toHaveLength(1);
  });

  it("say so where the Bulletin lists nothing for a Term", () => {
    expect(text(termsHtml({ label: "", terms: [{ label: "Year 1 Fall", credits: 0, entries: [] }] }))).toContain(
      "The Bulletin lists nothing for this term.",
    );
  });

  it("cannot be broken out of by a label with markup in it", () => {
    // The labels are the Bulletin's, scraped. One of them is a web address.
    const html = termsHtml({
      label: "",
      terms: [{ label: 'Year 1 <b>Fall</b>', entries: [{ slot: '<img src=x onerror="alert(1)"> & more' }, { course: "<script>" }] }],
    });
    expect(html).not.toMatch(/<b>|<img|<script>/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; more");
  });
});

describe("what a Template is called and adds up to", () => {
  it("is called what the Bulletin calls it, or its place where the Bulletin calls it nothing", () => {
    expect(templateName(template, 0)).toBe("Computer Science, B.S. at Erie Campus");
    expect(templateName({ label: "", terms: [fall] }, 2)).toBe("Plan 3 (the Bulletin gives it no name)");
  });

  it("adds up to its Terms and its credits", () => {
    expect(templateSummary(template)).toBe("1 term · 122 credits");
    expect(templateSummary({ label: "", terms: [fall, fall] })).toBe("2 terms");
    expect(creditsText(1)).toBe("1 credit");
    expect(creditsText(1.5)).toBe("1.5 credits");
  });
});
