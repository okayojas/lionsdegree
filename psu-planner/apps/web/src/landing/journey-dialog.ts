/** Field notes for a stop on the 3D journey.
 *
 * The spec says to reuse "the existing field-notes dialog" — there is no such
 * thing in the app. It lived in the proof-of-concept at the repo root, so
 * this is the port, and it is the only one: the planner's course modal is a
 * React component inside the planner bundle, and the landing page must never
 * reach into that (`test/build-output.test.ts` asserts exactly that).
 *
 * `<dialog>` does the focus trap, the backdrop, and Escape natively, so the
 * only things written by hand here are the ones it does not do: scroll lock,
 * focus restoration to the trigger, and prev/next wrapping.
 *
 * WHAT A RECORD MAY SAY: a title, a credit count, the Bulletin's own enforced
 * requirement string, and the topic terms the pipeline extracted. Never a
 * course description — see DECISIONS.md 5.1 and the note in `journey-data.ts`.
 */
import { JOURNEY_NOTES, BULLETIN_URL, type JourneyNote } from "./journey-data.js";

export interface DialogHandle {
  /** Open on the note for `code`, if there is one. Returns whether it opened. */
  open(code: string, trigger: HTMLElement): boolean;
  dispose(): void;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function mountDialog(): DialogHandle {
  const dialog = document.createElement("dialog");
  dialog.className = "journey-dialog";
  dialog.innerHTML = `
    <article class="jd-body">
      <p class="jd-kind" data-kind></p>
      <h2 class="jd-code" data-code></h2>
      <p class="jd-title" data-title></p>
      <dl class="jd-facts">
        <dt>Credits</dt><dd data-credits></dd>
        <dt>Required first</dt><dd data-requires></dd>
        <dt>Topics</dt><dd data-about></dd>
      </dl>
      <p class="jd-question" data-question></p>
      <p class="jd-source">
        Course text lives on the
        <a data-source target="_blank" rel="noopener noreferrer">Penn State Bulletin</a>.
        Unofficial — verify with your adviser before you register.
      </p>
    </article>
    <nav class="jd-nav">
      <button type="button" data-prev aria-label="Previous field note">&larr;</button>
      <span class="jd-count" data-count></span>
      <button type="button" data-next aria-label="Next field note">&rarr;</button>
      <button type="button" class="jd-close" data-close>Close</button>
    </nav>
  `;
  document.body.appendChild(dialog);

  const $ = <T extends HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!;
  const body = $(".jd-body");
  const status = document.createElement("p");
  // Moving between records swaps text inside an already-open dialog, which a
  // screen reader has no reason to re-announce on its own.
  status.className = "jd-live";
  status.setAttribute("aria-live", "polite");
  dialog.appendChild(status);

  let index = 0;
  let opener: HTMLElement | null = null;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function render(note: JourneyNote): void {
    $("[data-kind]").textContent = note.kind;
    $("[data-code]").textContent = note.code;
    $("[data-title]").textContent = titleFor(note.code);
    $("[data-credits]").textContent = note.credits;
    $("[data-requires]").textContent = note.requires ?? "Nothing listed in the Bulletin.";
    $("[data-about]").textContent = note.about.join(" · ");
    $("[data-question]").textContent = note.question;
    $<HTMLAnchorElement>("[data-source]").href = BULLETIN_URL;
    $("[data-count]").textContent = `${pad(index + 1)} / ${pad(JOURNEY_NOTES.length)}`;
    status.textContent = `${note.code}, note ${index + 1} of ${JOURNEY_NOTES.length}.`;
  }

  function titleFor(code: string): string {
    // Titles live on the nodes, not the notes, so there is one source for
    // them and the catalog test checks that one.
    return (
      document.querySelector<HTMLElement>(`.journey-label button[data-code="${CSS.escape(code)}"] span`)?.textContent ?? ""
    );
  }

  let swapping = 0;
  function swap(next: number): void {
    index = (next + JOURNEY_NOTES.length) % JOURNEY_NOTES.length;
    if (reduced()) {
      render(JOURNEY_NOTES[index]);
      return;
    }
    body.classList.add("is-swapping");
    clearTimeout(swapping);
    swapping = window.setTimeout(() => {
      render(JOURNEY_NOTES[index]);
      body.classList.remove("is-swapping");
    }, 120);
  }

  function close(): void {
    dialog.close();
    document.body.style.overflow = "";
    // Without preventScroll the page jumps back to wherever the label was
    // projected at open time, which on a scroll-driven scene is not where
    // the reader is now.
    opener?.focus({ preventScroll: true });
    opener = null;
  }

  const onKey = (e: KeyboardEvent) => {
    if (!dialog.open) return;
    if (e.key === "ArrowRight") swap(index + 1);
    if (e.key === "ArrowLeft") swap(index - 1);
  };
  const onCancel = (e: Event) => {
    // Escape: let `<dialog>` have the intent, keep the cleanup.
    e.preventDefault();
    close();
  };
  const onBackdrop = (e: MouseEvent) => {
    if (e.target === dialog) close();
  };

  $("[data-close]").addEventListener("click", close);
  $("[data-prev]").addEventListener("click", () => swap(index - 1));
  $("[data-next]").addEventListener("click", () => swap(index + 1));
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("click", onBackdrop);
  addEventListener("keydown", onKey);

  return {
    open(code, trigger) {
      const found = JOURNEY_NOTES.findIndex((n) => n.code === code);
      // Only four of the thirteen stops carry a note. A label with nothing
      // to say should do nothing rather than open the wrong record.
      if (found < 0) return false;
      index = found;
      opener = trigger;
      render(JOURNEY_NOTES[index]);
      document.body.style.overflow = "hidden";
      dialog.showModal();
      $("[data-close]").focus();
      return true;
    },
    dispose() {
      clearTimeout(swapping);
      removeEventListener("keydown", onKey);
      if (dialog.open) {
        dialog.close();
        document.body.style.overflow = "";
      }
      dialog.remove();
    },
  };
}
