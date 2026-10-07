/* A tombstone, not a service worker.
 *
 * Before the planner moved to /plan/, a worker was registered at the origin
 * ROOT and precached the planner shell as "/". Anyone who used the app still
 * carries that registration, and it serves them the old shell from cache --
 * an app referencing JavaScript this build no longer emits.
 *
 * Cleanup from the page cannot reach them: a controlled client is answered
 * from precache, so the landing page's script never runs. The browser does
 * still re-fetch the worker script itself, which is the one hook left. If
 * this file simply did not exist, that fetch would 404 and the browser would
 * KEEP the old registration rather than drop it.
 *
 * So the file stays, and does the opposite of a worker: clears every cache,
 * unregisters itself, and reloads open tabs onto the real network. The live
 * worker is at /plan/sw.js and is untouched by this.
 *
 * Safe to delete once no installs from before the split remain. There is no
 * way to know when that is, and it costs a few hundred bytes, so it stays. */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});

// Never answer a request from cache while winding down.
self.addEventListener("fetch", () => {});
