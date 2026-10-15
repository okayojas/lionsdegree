/** The feedback form on the landing page.
 *
 * Writes straight to Supabase from the page. The anon key is already in the
 * bundle for auth and plan sync, and the `feedback` table grants INSERT and
 * nothing else (supabase/migrations/0002_feedback.sql), so no server sits in
 * between and nothing new has to be deployed for this to work.
 *
 * Progressive enhancement: the markup contains a working `mailto:` link and a
 * visible address BEFORE this runs. If the script never loads, or sync is not
 * configured for this build, the section still gives a student a way to reach
 * a human — which is the whole point of a contact section, and the thing a
 * JavaScript-only form quietly takes away.
 */
import { supabase, syncConfigured } from "./data/sync";

const MAX = 4000;
const MIN = 4;

type State = "idle" | "sending" | "sent" | "error";

function setState(form: HTMLFormElement, state: State, message?: string): void {
  form.dataset.state = state;
  const status = form.querySelector<HTMLElement>("[data-status]");
  if (!status) return;
  // The live region is written to, never replaced: swapping the node out can
  // leave a screen reader announcing nothing at all.
  status.textContent = message ?? "";
  status.hidden = !message;
}

async function send(form: HTMLFormElement): Promise<void> {
  const body = form.querySelector<HTMLTextAreaElement>("#fb-body");
  const email = form.querySelector<HTMLInputElement>("#fb-email");
  const trap = form.querySelector<HTMLInputElement>("#fb-website");
  if (!body) return;

  const text = body.value.trim();
  if (text.length < MIN) {
    setState(form, "error", "Tell us a little more than that and we'll read it.");
    body.focus();
    return;
  }
  if (text.length > MAX) {
    setState(form, "error", `That's longer than we can store. Trim it to ${MAX.toLocaleString()} characters.`);
    body.focus();
    return;
  }
  // Honeypot: a field no human sees, which naive bots fill in anyway. Report
  // success rather than an error — telling a bot it was caught just teaches
  // whoever wrote it to stop filling the field.
  if (trap?.value) {
    setState(form, "sent", "Thanks — that's been sent.");
    form.reset();
    return;
  }

  const sb = supabase();
  if (!sb) {
    setState(form, "error", "The form isn't available on this build. The email address above works.");
    return;
  }

  setState(form, "sending", "Sending…");
  try {
    const { data } = await sb.auth.getUser();
    const { error } = await sb.from("feedback").insert({
      body: text,
      email: email?.value.trim() || null,
      page: location.pathname.slice(0, 200),
      user_id: data.user?.id ?? null,
    });
    if (error) throw error;
    setState(form, "sent", "Thanks — that's been sent. We read everything.");
    form.reset();
  } catch (e) {
    // Say what to do next. An error that only reports failure leaves someone
    // with something to say and nowhere to put it.
    console.error("[feedback] insert failed", e);
    setState(form, "error", "That didn't send. The email address above still works, and nothing you typed was lost.");
  }
}

const form = document.querySelector<HTMLFormElement>("#feedback-form");
if (form) {
  // Revealed only once this script is running: without it the markup shows
  // the address instead, which works with no JavaScript at all.
  form.hidden = false;
  form.dataset.enhanced = "true";
  if (!syncConfigured) form.dataset.state = "unavailable";

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send(form);
  });

  const body = form.querySelector<HTMLTextAreaElement>("#fb-body");
  const count = form.querySelector<HTMLElement>("[data-count]");
  if (body && count) {
    const update = () => {
      const n = body.value.trim().length;
      count.textContent = n > MAX * 0.8 ? `${n.toLocaleString()} / ${MAX.toLocaleString()}` : "";
    };
    body.addEventListener("input", update);
    update();
  }
}
