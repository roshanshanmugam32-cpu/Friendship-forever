/*
 * Eternal service worker.
 * - HTML navigations: network-first (short timeout) so deployments show up immediately,
 *   falling back to the cached app shell when offline or on a very slow connection.
 * - Same-origin static files: network-first with cache fallback (only full 200 responses).
 * - Never intercepted/cached: non-GET, cross-origin (Supabase, Google, fonts), Range/media
 *   requests, API/auth-like paths, and arbitrary JSON.
 * - Push + notification click: focuses the open window and asks the page to navigate
 *   (ETERNAL_NAVIGATE) instead of force-reloading it.
 */
const CACHE_PREFIX = "eternal-shell-";
const CACHE_NAME = CACHE_PREFIX + "v3";
const SHELL_URL = "./";
const NAV_TIMEOUT_MS = 4000;
const PRECACHE = [SHELL_URL, "./manifest.json", "./logo.png", "./eternal-icon-192.png", "./eternal-icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Best effort: a missing file must never block installation.
    await Promise.allSettled(PRECACHE.map(async (path) => {
      const response = await fetch(path, { cache: "reload" });
      if (response.status === 200 && response.type === "basic") await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ---------- Push ---------- */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Eternal", body: event.data ? event.data.text() : "You have a new notification." };
  }
  const options = {
    body: data.body || "You have a new notification.",
    icon: data.icon || "./eternal-icon-192.png",
    badge: data.badge || "./eternal-icon-192.png",
    tag: data.tag || "eternal-notification",
    renotify: data.renotify === true,
    data: {
      url: typeof data.url === "string" ? data.url : "./",
      type: data.type || "general",
      eventKey: data.eventKey || ""
    },
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };
  event.waitUntil(self.registration.showNotification(data.title || "Eternal", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let target;
    try {
      target = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope);
    } catch {
      target = new URL("./", self.registration.scope);
    }
    // Push payloads may not send people to other sites.
    if (target.origin !== self.location.origin) target = new URL("./", self.registration.scope);

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const own = windows.find((c) => c.url.startsWith(self.registration.scope));
    if (own) {
      // The page already handles this message; this avoids a full reload (blank flash, lost state).
      own.postMessage({ type: "ETERNAL_NAVIGATE", url: target.href });
      return own.focus();
    }
    return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    windows.forEach((c) => c.postMessage({ type: "ETERNAL_RESUBSCRIBE" }));
  })());
});

/* ---------- Fetch ---------- */
async function putSafely(cacheKey, response) {
  // Only complete, successful, same-origin responses; a failed put must never break the page.
  if (response.status !== 200 || response.type !== "basic") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, response);
  } catch {
    // Quota or similar: ignore.
  }
}

function keepAlive(event, promise) {
  try {
    event.waitUntil(promise);
  } catch {
    // Event already finished (slow network after fallback): the promise still runs.
  }
}

const PRIVATE_PATH = /\/(api|auth|login|logout|token|graphql|rest|storage|realtime)(\/|$)/i;
const STATIC_FILE = /\.(?:css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return; // audio/video seeking

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (PRIVATE_PATH.test(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const isShell = url.pathname === new URL(SHELL_URL, self.registration.scope).pathname ||
                      url.pathname.endsWith("/index.html");
      const cacheKey = isShell ? SHELL_URL : request;
      const network = fetch(request).then((response) => {
        keepAlive(event, putSafely(cacheKey, response.clone()));
        return response;
      });
      try {
        // Fall back to cache if the network is slow, so the app never sits on a blank screen.
        return await Promise.race([
          network,
          new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), NAV_TIMEOUT_MS))
        ]);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = (await cache.match(cacheKey)) || (await cache.match(SHELL_URL));
        if (cached) return cached;
        try {
          return await network; // nothing cached yet: keep waiting for the real response
        } catch {
          return new Response("You are offline. Please reconnect and reload Eternal.", {
            status: 503,
            statusText: "Offline",
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      }
    })());
    return;
  }

  if (!STATIC_FILE.test(url.pathname) && !url.pathname.endsWith("/manifest.json")) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      keepAlive(event, putSafely(request, response.clone()));
      return response;
    } catch {
      const cached = await caches.match(request, { cacheName: CACHE_NAME });
      return cached || Response.error();
    }
  })());
});
