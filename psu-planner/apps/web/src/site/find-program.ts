/** Narrows the Sample plans list as a student types.
 *
 * A PROGRESSIVE ENHANCEMENT. The list is in the page (src/site/sample-plans.ts
 * and the build put it there), every entry already links into the planner,
 * and with this script blocked the page is a long list that works. So the
 * box to type in is `hidden` in the markup and shown here: a search box that
 * does nothing is worse than a list with none.
 *
 * What counts as a match is `finds`, beside the code that wrote the list.
 */
import { finds } from "./sample-plans";

const finder = document.querySelector<HTMLElement>("#finder");
const input = document.querySelector<HTMLInputElement>("#find-program");
const status = document.querySelector<HTMLElement>("#finder-status");
const list = document.querySelector<HTMLElement>("#programs");

if (finder && input && status && list) {
  const programs = [...list.querySelectorAll<HTMLElement>(":scope > li")];
  const total = programs.length;

  const narrow = (): void => {
    const typed = input.value.trim();
    let showing = 0;
    for (const program of programs) {
      const found = finds(program.dataset.find ?? "", typed);
      program.hidden = !found;
      if (found) showing++;
    }
    // Said, not only shown: the list changing under a screen reader's cursor
    // is silent unless something says how much of it is left.
    status.textContent = !typed
      ? `${total.toLocaleString("en-US")} programs`
      : showing
        ? `${showing} of ${total.toLocaleString("en-US")} programs match`
        : `No program matches “${typed}”. Try fewer letters, or just the subject.`;
  };

  finder.hidden = false;
  input.addEventListener("input", narrow);
  // A value the browser restored (the back button) is narrowed straight away.
  narrow();
}
