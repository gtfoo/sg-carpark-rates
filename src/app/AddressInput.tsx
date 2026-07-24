"use client";

import { useEffect, useRef, useState } from "react";
import type { Suggestion } from "@/lib/onemap";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Fired when a suggestion is picked, so the caller can search immediately. */
  onPick: (s: Suggestion) => void;
}

const DEBOUNCE_MS = 250;

export default function AddressInput({ value, onChange, onPick }: Props) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // Set when the user picks a suggestion, so the resulting value change does
  // not immediately trigger a fresh lookup for the text we just inserted.
  const suppress = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    if (value.trim().length < 2) {
      setItems([]);
      setOpen(false);
      return;
    }

    // Abort in-flight lookups so a slow early keystroke cannot overwrite the
    // results of a later, more specific one.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as { suggestions: Suggestion[] };
        setItems(body.suggestions);
        setOpen(body.suggestions.length > 0);
        setActive(-1);
      } catch {
        /* aborted or offline — autocomplete stays quiet */
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  // Dismiss when tapping outside — important on mobile, where there is no Esc.
  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  function choose(s: Suggestion) {
    suppress.current = true;
    onChange(s.name);
    setOpen(false);
    setItems([]);
    setActive(-1);
    onPick(s);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      // Only intercept Enter when a suggestion is highlighted, so plain Enter
      // still submits whatever the user typed.
      e.preventDefault();
      const picked = items[active];
      if (picked) choose(picked);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => items.length > 0 && setOpen(true)}
        placeholder="Where are you going?"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls="address-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `suggestion-${active}` : undefined}
        className="w-full rounded-xl border px-4 py-3 outline-none"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />

      {open && (
        <ul
          id="address-suggestions"
          role="listbox"
          className="absolute z-[1000] mt-1 w-full overflow-hidden rounded-xl border shadow-lg"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          {items.map((s, i) => (
            <li
              key={s.id}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => {
                // pointerdown, not click: the input's blur would otherwise
                // close the list before the click lands.
                e.preventDefault();
                choose(s);
              }}
              onMouseEnter={() => setActive(i)}
              className="cursor-pointer px-4 py-2.5"
              style={{
                background: i === active ? "var(--border)" : "transparent",
              }}
            >
              <p className="truncate text-sm font-medium">{s.name}</p>
              <p className="truncate text-xs" style={{ color: "var(--muted)" }}>
                {s.postal ? `${s.address}` : s.address}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
