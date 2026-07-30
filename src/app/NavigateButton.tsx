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

/** parking.sg's native apps and its site. */
const PARKING_SG = {
  // Follow the canonical host directly: parking.sg 301s to www, and a redirect
  // can stop iOS from matching a Universal Link to the installed app.
  web: "https://www.parking.sg/",
  androidPackage: "sg.parking.streetsmart",
  playStore:
    "https://play.google.com/store/apps/details?id=sg.parking.streetsmart",
  appStore: "https://apps.apple.com/sg/app/parking-sg/id1286602494",
} as const;

/**
 * Android opens a specific installed app by package id via an intent: URL.
 *
 * This asks for the app's LAUNCHER activity (the MAIN/LAUNCHER pair) rather
 * than pointing at a https://www.parking.sg/ URL: a URL-shaped intent only
 * resolves if the app declares an intent-filter for that exact host, which
 * parking.sg's app does not appear to do — Chrome then silently falls through
 * to the web. Launching by package sidesteps that entirely.
 *
 * `S.browser_fallback_url` is what Chrome loads when the app isn't installed.
 */
const ANDROID_INTENT =
  `intent:#Intent;package=${PARKING_SG.androidPackage};` +
  `action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;` +
  `S.browser_fallback_url=${encodeURIComponent(PARKING_SG.playStore)};end`;

/**
 * "Pay with parking.sg" for coupon car parks.
 *
 * On Android this opens the installed parking.sg app directly (intent: URL by
 * package id), falling back to the Play Store listing. Elsewhere — including
 * iOS — it opens https://www.parking.sg/, which hands off to the installed app
 * automatically IF parking.sg publishes Universal Links for that domain.
 *
 * There is no documented parking.sg URL scheme and no public per-car-park deep
 * link, so iOS can't be forced open and the app always lands on its own home
 * screen, where the driver picks the car park. Guessing a scheme would just
 * show a broken-link error when wrong, so we don't.
 */
export function ParkingSgButton() {
  const [href, setHref] = useState<string>(PARKING_SG.web);
  const [isIos, setIsIos] = useState(false);
  const isIntent = href.startsWith("intent:");

  useEffect(() => {
    // Resolved after mount: the server has no user agent, and rendering a
    // different href on the server would be a hydration mismatch.
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) {
      setHref(ANDROID_INTENT);
    } else if (/iphone|ipad|ipod/i.test(ua)) {
      setIsIos(true);
    }
  }, []);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a
        href={href}
        // An intent: URL must navigate in the current tab — opening it in a new
        // tab stops Chrome handing off to the app on some Android versions.
        target={isIntent ? undefined : "_blank"}
        rel={isIntent ? undefined : "noreferrer"}
        className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium"
        style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
      >
        🅿️ Pay with parking.sg
      </a>
      {/*
        iOS can't be made to open an app that publishes no URL scheme, and we
        can't detect whether it's installed. The button above opens
        www.parking.sg, which hands off to the app if parking.sg publishes
        Universal Links; this second link is the App Store for anyone who
        doesn't have it. Sending everyone straight to the App Store would put an
        extra tap in front of people who already have the app.
      */}
      {isIos && (
        <a
          href={PARKING_SG.appStore}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] underline underline-offset-2"
          style={{ color: "var(--muted)" }}
        >
          Get the app
        </a>
      )}
    </span>
  );
}
