import { z } from "zod";

const AstNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal("true") }),
    z.object({ op: z.literal("course"), code: z.string() }),
    z.object({ op: z.literal("phrase"), text: z.string() }),
    z.object({ op: z.literal("and"), a: AstNodeSchema, b: AstNodeSchema }),
    z.object({ op: z.literal("or"), a: AstNodeSchema, b: AstNodeSchema }),
    z.object({ op: z.literal("concurrent"), a: AstNodeSchema }),
  ]),
);

export const CourseSchema = z.object({
  code: z.string(),
  subject: z.string(),
  number: z.string(),
  display: z.string(),
  title: z.string(),
  credits: z.string(),
  creditsParsed: z.object({ min: z.number(), max: z.number(), repeatableMax: z.number().nullable() }).nullable(),
  description: z.string(),
  enforced: z.string().nullable(),
  concurrent: z.string().nullable(),
  prereqAdvisory: z.string().nullable(),
  prereqAst: AstNodeSchema.nullable(),
  concurrentAst: AstNodeSchema.nullable(),
  astComplete: z.boolean(),
  genEd: z.array(z.string()),
  attributes: z.array(z.string()),
  crossListings: z.array(z.string()),
  aliases: z.array(z.string()),
  level: z.enum(["undergraduate", "graduate"]),
  url: z.string(),
  extraRaw: z.array(z.string()),
});
export type Course = z.infer<typeof CourseSchema>;

export const RuleSchema = z.union([
  z.object({
    type: z.literal("course"),
    code: z.string(),
    credits: z.number().nullable(),
    /** Referenced code didn't resolve in the course index (bulletin staleness). */
    unverified: z.boolean().optional(),
    /** Original bulletin code when integrity validation resolved a unique variant (ESC 410 -> ESC 410H). */
    resolvedFrom: z.string().optional(),
  }),
  z.object({ type: z.literal("oneOf"), options: z.array(z.string()), credits: z.number().nullable() }),
  z.object({
    type: z.literal("chooseN"),
    n: z.number(),
    options: z.array(z.string()),
    credits: z.number().nullable(),
    commentRaw: z.string(),
  }),
  z.object({
    type: z.literal("selectCredits"),
    credits: z.number().nullable(),
    commentRaw: z.string(),
    from: z
      .union([
        z.object({ kind: z.literal("courses"), courses: z.array(z.string()) }),
        z.object({ kind: z.literal("pattern"), subject: z.string(), minLevel: z.number().nullable() }),
        z.object({ kind: z.literal("genEd"), domain: z.string() }),
      ])
      .nullable(),
  }),
  z.object({ type: z.literal("genEd"), domain: z.string(), credits: z.number().nullable(), commentRaw: z.string() }),
  /** Organizational label or policy note — carries no checkable requirement
   * itself (e.g. "Evolution Group:", "A maximum of 3 credits may be chosen
   * from:"). Kept for display; does not poison the structured flag. */
  z.object({ type: z.literal("note"), commentRaw: z.string() }),
  z.object({ type: z.literal("unstructured"), commentRaw: z.string() }),
]);
export type Rule = z.infer<typeof RuleSchema>;

export const RequirementSectionSchema = z.object({
  heading: z.string(),
  kind: z.enum(["prescribed", "additional", "supporting", "geneds", "electives", "other"]),
  creditsRequired: z.number().nullable(),
  rules: z.array(RuleSchema),
  structured: z.boolean(),
  llmNormalized: z.boolean(),
  rawText: z.string(),
});
export type RequirementSection = z.infer<typeof RequirementSectionSchema>;

export const PlanEntrySchema = z.union([
  z.object({
    type: z.literal("course"),
    code: z.string(),
    credits: z.number().nullable(),
    footnotes: z.array(z.string()),
    /** "CMPSC 121 or 131" cells: first code is the default, these are the other choices. */
    alternatives: z.array(z.string()).default([]),
    unverified: z.boolean().optional(),
    resolvedFrom: z.string().optional(),
  }),
  z.object({ type: z.literal("genEd"), label: z.string(), domain: z.string().nullable(), credits: z.number().nullable(), footnotes: z.array(z.string()) }),
  z.object({ type: z.literal("placeholder"), label: z.string(), credits: z.number().nullable(), footnotes: z.array(z.string()) }),
]);
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const SuggestedPlanSchema = z.object({
  /** Heading above the plan grid, e.g. "University Park (CMPSC_BS)". */
  campusLabel: z.string(),
  semesters: z.array(
    z.object({
      year: z.number(),
      term: z.string(),
      label: z.string(),
      credits: z.number().nullable(),
      entries: z.array(PlanEntrySchema),
    }),
  ),
  totalCredits: z.number().nullable(),
  footnotes: z.record(z.string(), z.string()),
});
export type SuggestedPlan = z.infer<typeof SuggestedPlanSchema>;

export const ProgramSchema = z.object({
  slug: z.string(),
  name: z.string(),
  type: z.enum(["major", "minor", "certificate"]),
  degree: z.string().nullable(),
  college: z.string().nullable(),
  campuses: z.array(z.string()),
  url: z.string(),
  totalCredits: z.number().nullable(),
  requirementSections: z.array(RequirementSectionSchema),
  suggestedPlans: z.array(SuggestedPlanSchema),
});
export type Program = z.infer<typeof ProgramSchema>;

export const ProgramLinkSchema = z.object({
  url: z.string(),
  slug: z.string(),
  title: z.string(),
  keywords: z.array(z.string()),
  type: z.enum(["major", "minor", "certificate"]),
});
export type ProgramLink = z.infer<typeof ProgramLinkSchema>;
