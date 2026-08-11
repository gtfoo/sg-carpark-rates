/*
 * Offline shell for Carpark SG.
 *
 * This app gets used in basements and multi-storey car parks, where signal is
 * often gone by the time you want it. Without a service worker that's the
 * browser's error page; with one the app at least loads and can say something
 * useful.
 *
 * WHAT IS NEVER CACHED: anything under /api/. Rates, live lot counts and
 * availability must be fetched or fail visibly. A cached "173 lots free" is
 * worse than no answer — it sends someone to a full car park believing a
 * number the app made up from history.
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;

self.addEventListener("install", (event) => {
  // Take over as soon as this version is ready rather than waiting for every
  // tab to close — a stale shell hanging around is the usual SW complaint.
  event.waitUntil(caches.open(SHELL).then((c) => c.add("/")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => !n.endsWith(VERSION)).map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // map tiles, nav apps
  if (url.pathname.startsWith("/api/")) return; // never cached, see above

  // Next's hashed build output is immutable, so cache-first is safe and is
  // what makes a cold offline load instant.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network first, so a deploy is picked up immediately and a cached
  // HTML can never reference chunks that no longer exist. The cache is only a
  // fallback for when the network isn't there.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
  }
});
