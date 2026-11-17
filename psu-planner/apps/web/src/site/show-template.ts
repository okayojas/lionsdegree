/** Shows a Program's Template under its row on the Sample plans page (#68).
 *
 * A PROGRESSIVE ENHANCEMENT, like the box that narrows the list. The page
 * without this script is a list with a link on every row; this adds a button
 * to each row, "See term by term", which is why the button is made here and
 * is not in the page: a button that does nothing is worse than none.
 *
 * ONE FILE, WHEN IT IS ASKED FOR. Each Program's Templates are a small file
 * of their own in the catalog. Nothing is fetched until a student presses a
 * row's button, and then that Program's file and no other. It is asked for
 * once: a row closed and opened again while its file is on the way, or after
 * it has arrived, asks for nothing more.
 *
 * NEVER AN EMPTY PLAN. A file that does not arrive, or is not a Template
 * file, is said in words, with a way to try again and the way into the
 * planner still there. What a Template is and how it is drawn is
 * src/site/template-view.ts.
 */
import { escapeHtml, plannerLink } from "./sample-plans";
import { readTemplates, templateName, templateSummary, termsHtml, type ProgramTemplates } from "./template-view";

const list = document.querySelector<HTMLElement>("#programs");
/** Where the Edition's Template files are: the build writes it on the list. */
const templatesAt = list?.dataset.templates;

interface Row {
  program: string;
  name: string;
  button: HTMLButtonElement;
  panel: HTMLElement;
  /** Where its file is: not asked for yet, on its way, here, or not coming. */
  file: "unasked" | "asked" | "shown" | "failed";
}

/** What has just happened, for a screen reader. In the page from the moment
 * this script runs, and empty: a live region is announced when its text
 * CHANGES, and one that is put into the page already full says nothing. */
const said = document.createElement("p");
said.className = "sr-only";
said.setAttribute("aria-live", "polite");
const say = (text: string): void => {
  said.textContent = text;
};

const openInPlanner = (row: Row): string =>
  `<a class="template-open" href="${plannerLink(row.program)}">Open this program in the planner<span class="sr-only">: ${escapeHtml(row.name)}</span></a>`;

function showFailure(row: Row, why: "did not arrive" | "could not be read"): void {
  const what =
    why === "did not arrive"
      ? `The plan for ${escapeHtml(row.name)} did not load. Check your connection, then try again.`
      : `The plan for ${escapeHtml(row.name)} could not be read, so none is shown.`;
  // An alert, which is announced when it is put in the page.
  row.panel.innerHTML = `
    <p class="template-error" role="alert">${what}</p>
    <p class="template-actions"><button type="button" class="template-retry">Try again</button>${openInPlanner(row)}</p>`;
  row.panel.querySelector<HTMLButtonElement>(".template-retry")?.addEventListener("click", () => {
    // "Try again" is about to be replaced by what comes back. The focus goes
    // to the row's own button first, and not to the top of the page.
    row.button.focus();
    void load(row);
  });
}

function showTemplates(row: Row, file: ProgramTemplates): void {
  const several = file.templates.length > 1;
  const choiceId = `template-choice-${row.program}`;
  // Which of the Program's plans, where it has more than one: one for each
  // option and campus, named as the Bulletin names them.
  const choice = several
    ? `<p class="template-choice">
        <label for="${choiceId}">Which plan <span class="template-count">${file.templates.length} for this program</span></label>
        <select id="${choiceId}">${file.templates
          .map((template, position) => `<option value="${position}">${escapeHtml(templateName(template, position))}</option>`)
          .join("")}</select>
      </p>`
    : "";
  // The Bulletin's own page for the Program: where its notes are, and where
  // a student checks any of this.
  const inBulletin = file.bulletin
    ? `<a class="template-open" href="${escapeHtml(file.bulletin)}">See it in the Bulletin<span class="sr-only">: ${escapeHtml(row.name)}</span></a>`
    : "";
  row.panel.innerHTML = `
    <h2 class="template-title">The Bulletin’s suggested plan<span class="sr-only"> for ${escapeHtml(row.name)}</span></h2>
    ${choice}
    <p class="template-summary"></p>
    <p class="template-key">A code is a course the Bulletin names. A dashed box is a choice it leaves open, in its own words: nothing has been picked for you.</p>
    <div class="template-terms"></div>
    <p class="template-actions">${openInPlanner(row)}${inBulletin}</p>`;

  const summary = row.panel.querySelector<HTMLElement>(".template-summary")!;
  const terms = row.panel.querySelector<HTMLElement>(".template-terms")!;
  const draw = (position: number): void => {
    const template = file.templates[position];
    // The plan's name in full, here as well as in the chooser: a chooser on
    // a phone cuts a long name off at the part that tells two plans apart.
    const name = several ? templateName(template, position) : template.label.trim();
    summary.textContent = [name, templateSummary(template)].filter(Boolean).join(" · ");
    terms.innerHTML = termsHtml(template);
    say(`${row.name}: ${summary.textContent}`);
  };
  draw(0);
  row.panel.querySelector<HTMLSelectElement>("select")?.addEventListener("change", (event) => {
    draw(Number((event.target as HTMLSelectElement).value));
  });
}

async function load(row: Row): Promise<void> {
  // One request at a time, and none once the plan is on the page.
  if (row.file === "asked" || row.file === "shown") return;
  row.file = "asked";
  row.panel.innerHTML = `<p class="template-status">Loading the plan…</p>`;
  say(`Loading the plan for ${row.name}`);
  let data: unknown;
  try {
    const response = await fetch(`${templatesAt}${encodeURIComponent(row.program)}.json`);
    if (!response.ok) throw new Error(String(response.status));
    data = await response.json();
  } catch {
    row.file = "failed";
    showFailure(row, "did not arrive");
    return;
  }
  const file = readTemplates(data, row.program);
  if (!file) {
    row.file = "failed";
    showFailure(row, "could not be read");
    return;
  }
  row.file = "shown";
  showTemplates(row, file);
}

function toggle(row: Row): void {
  const opening = row.button.getAttribute("aria-expanded") !== "true";
  row.button.setAttribute("aria-expanded", String(opening));
  row.panel.hidden = !opening;
  // A row that failed is asked for again when it is opened again, which is
  // what someone back on a connection would expect.
  if (opening) void load(row);
}

if (list && templatesAt) {
  list.after(said);
  for (const item of list.querySelectorAll<HTMLElement>(":scope > li")) {
    const program = item.dataset.program;
    const name = item.querySelector(".program-name")?.textContent?.trim();
    const actions = item.querySelector(".program-actions");
    if (!program || !name || !actions) continue;

    const panel = document.createElement("div");
    panel.className = "template";
    panel.id = `template-${program}`;
    panel.hidden = true;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "program-see";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panel.id);
    button.innerHTML = `See term by term<span class="sr-only">: ${escapeHtml(name)}</span>`;

    const row: Row = { program, name, button, panel, file: "unasked" };
    button.addEventListener("click", () => toggle(row));
    // Before the link: the row reads name, where, look, go.
    actions.prepend(button);
    item.append(panel);
  }
}
