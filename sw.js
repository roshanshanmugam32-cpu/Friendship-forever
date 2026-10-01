const CACHE_NAME = "friendship-forever-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* =========================================================
   ETERNAL — PUSH NOTIFICATIONS
========================================================= */

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "Eternal",
      body: event.data ? event.data.text() : "You have a new notification."
    };
  }

  const title = data.title || "Eternal";

  const options = {
    body: data.body || "You have a new notification.",
    icon: data.icon || "./eternal-icon-192.png",
    badge: data.badge || "./eternal-icon-192.png",

    tag: data.tag || "eternal-notification",

    renotify: data.renotify === true,

    data: {
      url: data.url || "./",
      type: data.type || "general",
      eventKey: data.eventKey || ""
    },

    vibrate: [200, 100, 200],

    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});


/* =========================================================
   NOTIFICATION CLICK
========================================================= */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const notificationData = event.notification.data || {};

  let targetUrl = notificationData.url || "./";

  if (!targetUrl.startsWith("http")) {
    targetUrl = new URL(
      targetUrl,
      self.location.origin
    ).href;
  }

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then((clientList) => {

      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }

      return null;
    })
  );
});


/* =========================================================
   EXISTING OFFLINE / FETCH BEHAVIOUR
========================================================= */

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request)
    )
  );
});
