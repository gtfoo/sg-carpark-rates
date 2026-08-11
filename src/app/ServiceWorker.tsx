"use client";

import { useEffect, useState } from "react";

/**
 * Registers the offline shell, and tells the user when they're offline.
 *
 * The banner matters as much as the caching: with a service worker the app
 * still loads without signal, which is exactly when it might quietly serve a
 * page whose search box can't reach anything. Better to say so.
 */
export default function ServiceWorker() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // After load, so registration never competes with the first paint.
      const register = () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
          // Unsupported, blocked, or private browsing. The app works without
          // it — offline is simply not available.
        });
      };
      if (document.readyState === "complete") register();
      else window.addEventListener("load", register, { once: true });
    }

    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (!offline) return null;

  return (
    <p
      role="status"
      className="mb-3 rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
    >
      You’re offline — rates and live lot counts need a connection, so searching
      won’t work until you’re back.
    </p>
  );
}
