"use client";

import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "carpark:theme";

/** Chrome tint per palette — must match the values in globals.css. */
const THEME_COLOUR: Record<"light" | "dark", string> = {
  light: "#f6f7f9",
  dark: "#0b0d10",
};

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    // Safari private browsing throws on access rather than returning null.
    return "system";
  }
}

/**
 * Applies the choice to the document.
 *
 * "system" removes the attribute entirely rather than writing a resolved
 * value: the CSS media query then takes over, so a phone flipping to dark at
 * sunset follows along without the app having to watch for it.
 */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;

  // The <meta> tags are media-scoped, so an explicit choice needs its own tag
  // or the browser chrome keeps tracking the system while the page doesn't.
  const resolved =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  let tag = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-explicit]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "theme-color";
    tag.dataset.explicit = "true";
    document.head.appendChild(tag);
  }
  tag.content = THEME_COLOUR[resolved];
}

const OPTIONS: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: "system", label: "Auto", hint: "Match system setting" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

export default function ThemeToggle() {
  // Starts as "system" on both server and client so the first render matches
  // the HTML; the stored value is read in the effect below. The inline script
  // in layout.tsx has already painted the right colours by then, so this only
  // corrects which button looks pressed, never the page itself.
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => setChoice(readStored()), []);

  function pick(next: ThemeChoice) {
    setChoice(next);
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Choice still applies for this session; it just won't be remembered.
    }
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex overflow-hidden rounded-lg border text-[11px]"
      style={{ borderColor: "var(--border)" }}
    >
      {OPTIONS.map((o) => {
        const active = choice === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => pick(o.value)}
            aria-pressed={active}
            title={o.hint}
            className="px-2 py-1 transition-colors"
            style={{
              background: active ? "var(--accent)" : "transparent",
              color: active ? "#fff" : "var(--muted)",
              fontSize: "11px",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
