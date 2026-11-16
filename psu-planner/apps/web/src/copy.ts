/** Copy buttons: the connection link and the discovery prompt, both on
 * /connect/.
 *
 * A progressive enhancement and nothing more: whatever is being copied is
 * plain selectable text in the markup, so the page works with this script
 * blocked, failed, or not yet parsed. That matters more here than on most
 * pages — someone setting up a connector is often doing it on a locked-down
 * machine.
 */
const COPIED_FOR = 1600;

function wire(btn: HTMLButtonElement): void {
  const target = document.getElementById(btn.dataset.copy ?? "");
  if (!target) return;
  const label = btn.textContent ?? "Copy";
  // The buttons are `hidden` in the markup and shown here, once there is
  // something behind them. With this script blocked the page has the text
  // and no button, which is the truth.
  btn.hidden = false;

  btn.addEventListener("click", async () => {
    const text = (target.textContent ?? "").trim();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      // Clipboard access is refused in plenty of ordinary situations — an
      // insecure origin, a permissions policy, a browser that simply says no.
      // Select the text instead so the keyboard shortcut still works, rather
      // than reporting a success that did not happen.
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      btn.textContent = "Press Ctrl+C";
    }
    btn.classList.add("is-done");
    window.setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("is-done");
    }, COPIED_FOR);
  });
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) wire(btn);
