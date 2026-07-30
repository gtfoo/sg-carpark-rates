"use client";

import { useState, useEffect } from "react";

/** External nav apps. Universal links that open the installed app on mobile. */
const NAV_APPS: {
  key: string;
  label: string;
  href: (lat: number, lng: number) => string;
}[] = [
  {
    key: "gmaps",
    label: "Google Maps",
    href: (lat, lng) =>
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  },
  {
    key: "waze",
    label: "Waze",
    href: (lat, lng) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  },
  {
    key: "apple",
    label: "Apple Maps",
    href: (lat, lng) => `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`,
  },
];

const NAV_STORAGE_KEY = "carpark:navApp";

/**
 * Per-carpark "Navigate" button. Remembers the last maps app chosen (in
 * localStorage) so it becomes a one-tap open next time, with a caret to switch.
 * Shared by the result cards and the map popups so both behave the same.
 */
export function NavigateButton({ lat, lng }: { lat: number; lng: number }) {
  const [open, setOpen] = useState(false);
  const [pref, setPref] = useState<string | null>(null);

  useEffect(() => {
    try {
      setPref(localStorage.getItem(NAV_STORAGE_KEY));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  function remember(key: string) {
    try {
      localStorage.setItem(NAV_STORAGE_KEY, key);
    } catch {
      /* ignore */
    }
    setPref(key);
    setOpen(false);
  }

  const prefApp = NAV_APPS.find((a) => a.key === pref) ?? null;

  return (
    <div className="relative mt-3">
      {prefApp ? (
        // Remembered app → one-tap open, with a caret to switch.
        <div
          className="inline-flex overflow-hidden rounded-lg text-xs font-semibold text-white"
          style={{ background: "var(--accent)" }}
        >
          <a
            href={prefApp.href(lat, lng)}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5"
          >
            🧭 {prefApp.label}
          </a>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label="Change navigation app"
            aria-expanded={open}
            className="border-l border-white/25 px-2 py-1.5"
          >
            ▾
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          🧭 Navigate
        </button>
      )}
      {open && (
        <div
          className="absolute left-0 z-10 mt-1 flex flex-col overflow-hidden rounded-lg border shadow-lg"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          {NAV_APPS.map((app) => (
            <a
              key={app.key}
              href={app.href(lat, lng)}
              target="_blank"
              rel="noreferrer"
              onClick={() => remember(app.key)}
              className="flex items-center justify-between gap-3 whitespace-nowrap px-4 py-2.5 text-xs hover:opacity-80"
              style={{ color: "var(--text)" }}
            >
              {app.label}
              {pref === app.key && (
                <span style={{ color: "var(--accent)" }}>✓</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * parking.sg is the official Digital Parking System web app (coupon parking).
 * There's no public per-car-park deep link, so this opens the app to the home
 * screen where the driver picks the car park and pays. On mobile it opens the
 * installed parking.sg app / PWA; on desktop, the site.
 */
export function ParkingSgButton() {
  return (
    <a
      href="https://parking.sg"
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium"
      style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
    >
      🅿️ Pay with parking.sg
    </a>
  );
}
