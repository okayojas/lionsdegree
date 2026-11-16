/** The sample Plan, written out as a reader meets it: eight Terms in order,
 * six Courses in each, top to bottom.
 *
 * A LITERAL, ON PURPOSE. The page prints the Plan from
 * src/landing/sample-plan.ts and the scene draws it from the same file. A
 * test that read the Plan from that file too would agree with whatever it
 * said, including a Course in the wrong Term. This is the second copy that
 * makes a comparison possible, for the page's list (landing.spec.ts) and the
 * scene's rectangle (scene.spec.ts).
 */
export const PLAN = [
  ["Fall 1", ["MATH 140", "PSYCH 100", "CMPSC 131", "CMPSC 150N", "ENGL 15", "ENGR 100"]],
  ["Spring 1", ["MATH 141", "PHYS 211", "CMPSC 132", "SOC 1", "MUSIC 4", "GEOG 30N"]],
  ["Fall 2", ["MATH 230", "PHYS 212", "CMPSC 221", "MATH 220", "CAS 100A", "THEA 100"]],
  ["Spring 2", ["ASTRO 5", "CMPEN 270", "CMPSC 222", "CMPSC 360", "PHIL 10", "KINES 77"]],
  ["Fall 3", ["STAT 318", "CMPSC 315", "CMPSC 465", "CMPSC 320", "HIST 21", "ASIA 100"]],
  ["Spring 3", ["STAT 319", "CMPSC 316", "CMPSC 461", "CMPSC 442", "ENGL 202C", "COMM 150N"]],
  ["Fall 4", ["CMPSC 448", "CMPSC 464", "CMPSC 483W", "CMPSC 471", "CMPSC 431W", "NUTR 100"]],
  ["Spring 4", ["CMPSC 455", "CMPSC 467", "CMPSC 410", "ARTH 100", "CMLIT 153", "EARTH 100"]],
] as const;
