/** The landing page's only script. It ships no planner code on purpose: the
 * page has to render and read correctly with JavaScript disabled, because link
 * previewers do not run scripts.
 *
 * Its one job is cleanup. Before the planner moved to /plan/, the service
 * worker was registered at the origin ROOT and precached the planner's shell
 * as "/". A student who installed the app then still carries that
 * registration, and it would serve them the old cached shell here -- an app
 * that references JavaScript this build no longer emits. Shedding it is what
 * keeps an existing installation working.
 *
 * Registrations scoped to /plan/ are the current ones and are left alone. */
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then(async (regs) => {
      let shed = false;
      for (const reg of regs) {
        // Only root-scoped registrations are stale; /plan/ is the live one.
        if (new URL(reg.scope).pathname === "/") {
          await reg.unregister();
          shed = true;
        }
      }
      if (shed) {
        // Caches are keyed by the old build; drop them so nothing stale is
        // served from here again.
        if ("caches" in window) {
          for (const key of await caches.keys()) await caches.delete(key);
        }
        location.reload();
      }
    })
    .catch(() => {
      /* never let cleanup break the page */
    });
}
