/** A Program's Template, Term by Term, as the Sample plans page shows it
 * (#60, #68).
 *
 * Two things, and neither touches the page: reading a published Template
 * file (scripts/templates.mjs writes them), and turning one Template into
 * markup. The script that fetches and shows is src/site/show-template.ts.
 *
 * WHAT THE PAGE SHOWS IS WHAT THE BULLETIN PUBLISHED. A Course it names is a
 * code. A choice it leaves open is a Slot, with the Bulletin's own label and
 * nothing put in it: which Course fills a Slot is the student's to decide, in
 * the planner. Nothing here knows a Course's title, and nothing here chooses.
 */
import { escapeHtml } from "./sample-plans";

/** A Course the Bulletin names, with the Courses it offers in its place.
 * `orUnlisted` are alternatives the Edition's catalog does not list. */
interface Alternatives {
  or?: readonly string[];
  orUnlisted?: readonly string[];
}
/** One line of a Term. */
export type TermEntry =
  | ({ course: string; credits?: number } & Alternatives)
  /** A code the Bulletin's plan names and the Edition's catalog does not have. */
  | ({ unlisted: string; credits?: number } & Alternatives)
  /** A choice the Bulletin leaves open, in its own words. */
  | { slot: string; credits?: number }
  /** A remark the Bulletin makes in this Term. Its words are not published. */
  | { note: true };

export interface Term {
  /** "Year 1 Fall". */
  label: string;
  credits?: number;
  entries: readonly TermEntry[];
}

export interface Template {
  /** The Bulletin's name for this plan: its option and campus. Empty where
   * the Bulletin gives it none. */
  label: string;
  credits?: number;
  terms: readonly Term[];
}

export interface ProgramTemplates {
  program: string;
  /** The Program's page in the Bulletin, where the file names one. */
  bulletin?: string;
  templates: readonly Template[];
}

/** Where a link to the Bulletin may point. Anything else in that field is
 * not a link this page will make. */
const BULLETIN = "https://bulletins.psu.edu/";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isCodes = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every(isText));
const isCredits = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value));

function isEntry(value: unknown): value is TermEntry {
  if (!isRecord(value)) return false;
  const kinds = ["course", "unlisted", "slot", "note"].filter((kind) => kind in value);
  // Exactly one thing: a line that is both a Course and a Slot is neither.
  if (kinds.length !== 1) return false;
  if (kinds[0] === "note") return value.note === true;
  return isText(value[kinds[0]]) && isCredits(value.credits) && isCodes(value.or) && isCodes(value.orUnlisted);
}

const isTerm = (value: unknown): value is Term =>
  isRecord(value) && isText(value.label) && isCredits(value.credits) && Array.isArray(value.entries) && value.entries.every(isEntry);

const isTemplate = (value: unknown): value is Template =>
  isRecord(value) &&
  typeof value.label === "string" &&
  isCredits(value.credits) &&
  Array.isArray(value.terms) &&
  // A plan with no Terms is not a plan. It is never drawn as an empty one.
  value.terms.length > 0 &&
  value.terms.every(isTerm);

/** A published Template file, checked, or null where it is not one that can
 * be shown: not for the Program that was asked for, no Template in it, or
 * anything in it that is not what a Template file carries.
 *
 * ALL OR NOTHING. A file that is half right is shown as a failure, not as
 * the half that parsed: a plan with a Term missing looks exactly like a plan,
 * and a student has no way to know it is short. */
export function readTemplates(data: unknown, program: string): ProgramTemplates | null {
  if (!isRecord(data) || data.program !== program) return null;
  if (!Array.isArray(data.templates) || data.templates.length === 0 || !data.templates.every(isTemplate)) return null;
  if (data.bulletin !== undefined && !(typeof data.bulletin === "string" && data.bulletin.startsWith(BULLETIN))) return null;
  return { program, templates: data.templates, ...(data.bulletin === undefined ? {} : { bulletin: data.bulletin }) };
}

/** "3 credits", "1 credit", "1.5 credits". */
export const creditsText = (credits: number): string => `${credits} credit${credits === 1 ? "" : "s"}`;

/** What a Template is called where a student picks between a Program's
 * several. The Bulletin's own name for it; where it has none, its place in
 * the Bulletin's order, and the admission. */
export const templateName = (template: Template, position: number): string =>
  template.label.trim() || `Plan ${position + 1} (the Bulletin gives it no name)`;

/** One line under a Template: how long it is and what it adds up to. */
export function templateSummary(template: Template): string {
  const terms = `${template.terms.length} term${template.terms.length === 1 ? "" : "s"}`;
  return template.credits === undefined ? terms : `${terms} · ${creditsText(template.credits)}`;
}

const code = (text: string): string => `<span class="code">${escapeHtml(text)}</span>`;

/** Credits at the end of a line: short for the eye, whole for a screen reader. */
const creditsHtml = (credits: number | undefined): string =>
  credits === undefined
    ? ""
    : ` <span class="entry-credits"><span aria-hidden="true">${credits} cr</span><span class="sr-only">${creditsText(credits)}</span></span>`;

/** Said of a code the Edition's catalog does not list. */
const UNLISTED = "not in this edition's catalog";

function alternativesHtml(entry: Alternatives): string {
  const listed = (entry.or ?? []).map((alternative) => ` <span class="entry-or">or ${code(alternative)}</span>`);
  const unlisted = (entry.orUnlisted ?? []).map(
    (alternative) => ` <span class="entry-or">or ${code(alternative)} <span class="entry-flag">${UNLISTED}</span></span>`,
  );
  return [...listed, ...unlisted].join("");
}

function entryHtml(entry: TermEntry): string {
  if ("note" in entry) {
    // The Bulletin says something here that is not a Course and not a
    // choice. The page says that it does, and where to read it.
    return `<li class="entry is-note"><span class="entry-what">A note in the Bulletin, not copied here.</span></li>`;
  }
  if ("slot" in entry) {
    // A Slot: the Bulletin's label, as it wrote it. "Open:" is for someone
    // who cannot see the dashed box that says the same thing.
    return `<li class="entry is-slot"><span class="entry-what"><span class="sr-only">Open: </span>${escapeHtml(entry.slot)}</span>${creditsHtml(entry.credits)}</li>`;
  }
  if ("unlisted" in entry) {
    return `<li class="entry is-unlisted"><span class="entry-what">${code(entry.unlisted)} <span class="entry-flag">${UNLISTED}</span>${alternativesHtml(entry)}</span>${creditsHtml(entry.credits)}</li>`;
  }
  return `<li class="entry"><span class="entry-what">${code(entry.course)}${alternativesHtml(entry)}</span>${creditsHtml(entry.credits)}</li>`;
}

/** A Template's Terms, in the Bulletin's order: each a heading, what it adds
 * up to, and its lines. */
export function termsHtml(template: Template): string {
  const terms = template.terms.map((term) => {
    const total = term.credits === undefined ? "" : `<p class="term-credits">${creditsText(term.credits)}</p>`;
    const lines = term.entries.length
      ? `<ul class="entries">${term.entries.map(entryHtml).join("")}</ul>`
      : // Said, because a Term drawn with nothing in it reads as a mistake.
        `<p class="term-empty">The Bulletin lists nothing for this term.</p>`;
    return `<li class="term"><h3 class="term-name">${escapeHtml(term.label)}</h3>${total}${lines}</li>`;
  });
  return `<ol class="terms">${terms.join("")}</ol>`;
}
