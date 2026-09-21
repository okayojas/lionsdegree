import fs from "node:fs";
import { parseSubjectPage } from "../src/parse/courses.js";
import { parseProgramPage } from "../src/parse/program.js";
// Directory holding the two saved bulletin pages this smoke test parses
// (`cmpsc.html`, `cs_bs.html`). Pass it as argv[2] or set SMOKE_DIR — there is
// no sensible default, since these are ad-hoc captures rather than the
// pipeline's own `data/raw/<edition>/` cache.
const raw = process.argv[2] ?? process.env.SMOKE_DIR;
if (!raw) {
  console.error("usage: tsx scripts/smoke.ts <dir-with-cmpsc.html-and-cs_bs.html>  (or set SMOKE_DIR)");
  process.exit(1);
}
const dir = raw.endsWith("/") || raw.endsWith("\\") ? raw : raw + "/";
const courses = parseSubjectPage(fs.readFileSync(dir + "cmpsc.html", "utf-8"), { level: "undergraduate", pageUrl: "x" });
console.log("courses:", courses.length);
const c101 = courses.find(c => c.code === "CMPSC 101")!;
console.log(JSON.stringify({ ...c101, description: c101.description.slice(0, 60) }, null, 1));
const { program, needsReview } = parseProgramPage(fs.readFileSync(dir + "cs_bs.html", "utf-8"), { url: "/undergraduate/colleges/engineering/computer-science-bs/", slug: "computer-science-bs", title: "Computer Science, B.S.", keywords: ["Baccalaureate Degree", "Penn State University Park"], type: "major" });
console.log("program:", program.name, "| totalCredits:", program.totalCredits, "| sections:", program.requirementSections.length, "| plans:", program.suggestedPlans.length, "| needsReview:", needsReview.length);
for (const s of program.requirementSections) console.log("  section:", s.kind, "|", s.heading.slice(0, 50), "| rules:", s.rules.length, "| structured:", s.structured);
const p = program.suggestedPlans[0];
console.log("plan[0]:", p.campusLabel, "| semesters:", p.semesters.length, "| total:", p.totalCredits, "| footnotes:", Object.keys(p.footnotes).length);
console.log("  sem1:", p.semesters[0].label, p.semesters[0].credits, JSON.stringify(p.semesters[0].entries.slice(0, 6)));
console.log("plan labels:", program.suggestedPlans.map(x => x.campusLabel));
