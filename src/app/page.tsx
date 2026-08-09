"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import AddressInput from "./AddressInput";
import { NavigateButton, ParkingSgButton } from "./NavigateButton";
import { useBrand } from "./brand-provider";
import { toSgtInputValue } from "@/lib/time";
import { formatFee } from "@/lib/format";
import type { SearchResponse, CarparkResult } from "@/lib/search";

/**
 * Leaflet reaches for `window` at import time, so it must never run during
 * SSR. Loading it lazily also keeps the map bundle out of the initial payload
 * for anyone who has not searched yet.
 */
const CarparkMap = dynamic(() => import("./CarparkMap"), {
  ssr: false,
  loading: () => (
    <div
      className="mb-4 flex h-[280px] items-center justify-center rounded-xl border text-sm"
      style={{ borderColor: "var(--border)", color: "var(--muted)" }}
    >
      Loading map…
    </div>
  ),
});

const DURATIONS = [
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "2h", minutes: 120 },
  { label: "3h", minutes: 180 },
  { label: "4h", minutes: 240 },
  { label: "8h", minutes: 480 },
];

export default function Home() {
  const brand = useBrand();
  const [query, setQuery] = useState("");
  const [minutes, setMinutes] = useState(120);
  // Custom parking duration (a number + min/hr) when the presets don't fit.
  const [customDuration, setCustomDuration] = useState(false);
  const [customVal, setCustomVal] = useState("90");
  const [customUnit, setCustomUnit] = useState<"min" | "hr">("min");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Waiting on the browser's location prompt, which can sit open for a while.
  const [locating, setLocating] = useState(false);
  // The term behind the current results, so we can re-run after adding a rate.
  const [lastTerm, setLastTerm] = useState("");

  // Empty means "now". Filled in on the client only when the user opts to pick
  // a time, so the default always reflects the current moment rather than
  // whenever the page happened to load.
  const [start, setStart] = useState("");
  const [useCustomStart, setUseCustomStart] = useState(false);

  // Web-lookup phase: null when idle, otherwise the current status + place name.
  const [lookup, setLookup] = useState<{
    state: "searching" | "found" | "notfound" | "error";
    name: string;
    reason?: string;
  } | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    void doSearch(query);
  }

  // `keepLookup` is set only when re-running the search right after a web
  // lookup, so the "found"/"not found" banner survives the refresh. A web
  // lookup is never triggered automatically anymore — it's user-initiated.
  async function doSearch(term: string, opts: { keepLookup?: boolean } = {}) {
    if (!term.trim()) return;
    await runQuery(`q=${encodeURIComponent(term)}`, term, opts);
  }

  /** Shared by the address search and "near me" — only the query differs. */
  async function runQuery(
    query: string,
    term: string,
    opts: { keepLookup?: boolean } = {},
  ) {
    setLastTerm(term);
    setLoading(true);
    setError(null);
    setData(null);
    if (!opts.keepLookup) setLookup(null);

    try {
      const startParam =
        useCustomStart && start ? `&start=${encodeURIComponent(start)}` : "";
      const res = await fetch(
        `/api/search?${query}&minutes=${minutes}${startParam}`,
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
      } else {
        setData(body as SearchResponse);
      }
    } catch {
      setError("Network error — are you online?");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Search from the device's own position.
   *
   * The browser only prompts in response to a gesture, so this must stay on a
   * button rather than firing on load — and a refused prompt is a choice, not
   * an error, so it's reported as one line rather than a failure state.
   */
  function searchHere() {
    if (!("geolocation" in navigator)) {
      setError("This browser can't share a location.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude, longitude } = pos.coords;
        void runQuery(`lat=${latitude}&lng=${longitude}`, "");
      },
      (err) => {
        setLocating(false);
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was declined — search by address instead."
            : "Couldn't get a location fix. Try again, or search by address.",
        );
      },
      // A rough fix is fine for "what's near me", and asking for a precise one
      // costs seconds and battery. Accept a fix up to a minute old.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function runLookup(
    dest: SearchResponse["destination"],
    term: string,
  ): Promise<void> {
    const name = dest.name;
    setLookup({ state: "searching", name });
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: name,
          postal: dest.postal,
          lat: dest.location.lat,
          lng: dest.location.lng,
        }),
      });
      const body = await res.json();
      if (res.ok && body.found) {
        setLookup({ state: "found", name });
        // Re-run the search so the new rate shows, keeping the "found" banner.
        await doSearch(term, { keepLookup: true });
        setTimeout(() => setLookup(null), 5000);
      } else if (body.status === "error") {
        setLookup({ state: "error", name, reason: body.reason });
      } else {
        setLookup({ state: "notfound", name, reason: body.reason });
      }
    } catch {
      setLookup({ state: "error", name, reason: "Network error." });
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg px-4 pb-16 pt-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">{brand.name}</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {brand.tagline}
        </p>
      </header>

      <form onSubmit={runSearch} className="mb-6">
        <AddressInput
          value={query}
          onChange={setQuery}
          onPick={(s) => {
            // Picking a suggestion is an explicit choice — search straight
            // away rather than making the user press the button as well.
            void doSearch(s.name);
          }}
          onUseLocation={searchHere}
          locating={locating}
        />

        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium" style={{ color: "var(--muted)" }}>
            How long are you parking?
          </p>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => {
              const active = !customDuration && d.minutes === minutes;
              return (
                <button
                  key={d.minutes}
                  type="button"
                  onClick={() => {
                    setCustomDuration(false);
                    setMinutes(d.minutes);
                  }}
                  aria-pressed={active}
                  className="rounded-lg border px-3 py-2 transition-colors"
                  style={{
                    background: active ? "var(--accent)" : "var(--surface)",
                    borderColor: active ? "var(--accent)" : "var(--border)",
                    color: active ? "#fff" : "var(--text)",
                  }}
                >
                  {d.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setCustomDuration(true);
                setMinutes(customMinutes(customVal, customUnit));
              }}
              aria-pressed={customDuration}
              className="rounded-lg border px-3 py-2 transition-colors"
              style={{
                background: customDuration ? "var(--accent)" : "var(--surface)",
                borderColor: customDuration ? "var(--accent)" : "var(--border)",
                color: customDuration ? "#fff" : "var(--text)",
              }}
            >
              Custom
            </button>
          </div>

          {customDuration && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={customUnit === "hr" ? 24 : 24 * 60}
                inputMode="numeric"
                value={customVal}
                onChange={(e) => {
                  setCustomVal(e.target.value);
                  setMinutes(customMinutes(e.target.value, customUnit));
                }}
                aria-label={`Parking duration amount (max 24 ${
                  customUnit === "hr" ? "hours" : "hours worth of minutes"
                })`}
                className="w-24 rounded-lg border px-3 py-2 text-sm"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              />
              {(["min", "hr"] as const).map((u) => {
                const active = customUnit === u;
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => {
                      setCustomUnit(u);
                      setMinutes(customMinutes(customVal, u));
                    }}
                    aria-pressed={active}
                    className="rounded-lg border px-3 py-2 text-sm transition-colors"
                    style={{
                      background: active ? "var(--accent)" : "var(--surface)",
                      borderColor: active ? "var(--accent)" : "var(--border)",
                      color: active ? "#fff" : "var(--text)",
                    }}
                  >
                    {u === "min" ? "minutes" : "hours"}
                  </button>
                );
              })}
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                = {formatDuration(minutes)}
              </span>
            </div>
          )}

          {customDuration && (
            <p
              className="mt-1.5 text-[11px]"
              style={{
                color: exceedsDurationMax(customVal, customUnit)
                  ? "#d97706"
                  : "var(--muted)",
              }}
            >
              {exceedsDurationMax(customVal, customUnit)
                ? `Longest we can price is 24 hours — using 24h instead of ${customVal} ${
                    customUnit === "hr" ? "hours" : "minutes"
                  }.`
                : "Up to 24 hours."}
            </p>
          )}
        </div>

        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium" style={{ color: "var(--muted)" }}>
            When are you arriving?
          </p>
          {!useCustomStart ? (
            <button
              type="button"
              onClick={() => {
                // Seed with the current Singapore time at the moment of the
                // click, not page load.
                setStart(toSgtInputValue(new Date()));
                setUseCustomStart(true);
              }}
              className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm"
              style={{
                background: "var(--surface)",
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
            >
              <span>Now</span>
              <span style={{ color: "var(--accent)" }}>Change ›</span>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-label="Parking start time (Singapore)"
                className="flex-1 rounded-lg border px-3 py-2"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setUseCustomStart(false);
                  setStart("");
                }}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)", color: "var(--muted)" }}
              >
                Now
              </button>
            </div>
          )}

          {/* Android's date picker shows a bare calendar grid with no weekday,
              and the day decides which rate card applies — so spell it out. */}
          {useCustomStart && describeStart(start) && (
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
              {describeStart(start)}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="mt-3 w-full rounded-xl px-4 py-3 font-semibold disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {loading ? "Searching…" : "Find parking"}
        </button>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-xl border px-4 py-3 text-sm"
          style={{ borderColor: "#7f1d1d", background: "#2a1214", color: "#fca5a5" }}
        >
          {error}
        </p>
      )}

      {lookup && <LookupBanner lookup={lookup} onDismiss={() => setLookup(null)} />}

      {data && (
        <Results
          data={data}
          lookupBusy={lookup?.state === "searching"}
          onWebLookup={() =>
            void runLookup(data.destination, lastTerm || data.destination.name)
          }
          onRateSaved={() => {
            setLookup(null);
            void doSearch(lastTerm || data.destination.name);
          }}
        />
      )}
    </main>
  );
}

function LookupBanner({
  lookup,
  onDismiss,
}: {
  lookup: {
    state: "searching" | "found" | "notfound" | "error";
    name: string;
    reason?: string;
  };
  onDismiss: () => void;
}) {
  const searching = lookup.state === "searching";
  const base =
    lookup.state === "searching"
      ? `Searching the web for ${lookup.name}'s parking rates…`
      : lookup.state === "found"
        ? `Found and saved a rate for ${lookup.name}.`
        : lookup.state === "notfound"
          ? `No rate found online for ${lookup.name}. Add one with “＋ Add a rate” below.`
          : `Couldn't look up ${lookup.name}.`;
  const text =
    (lookup.state === "error" || lookup.state === "notfound") && lookup.reason
      ? `${base} ${lookup.reason}`
      : base;
  const accent =
    lookup.state === "found"
      ? "#22c55e"
      : lookup.state === "searching"
        ? "var(--accent)"
        : "#d97706";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {searching ? (
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2"
          style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
        />
      ) : (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: accent }}
        />
      )}
      <span className="flex-1" style={{ color: "var(--text)" }}>
        {text}
      </span>
      {!searching && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-lg leading-none"
          style={{ color: "var(--muted)" }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function Results({
  data,
  lookupBusy,
  onWebLookup,
  onRateSaved,
}: {
  data: SearchResponse;
  lookupBusy: boolean;
  onWebLookup: () => void;
  onRateSaved: () => void;
}) {
  const [sortBy, setSortBy] = useState<"distance" | "price">("distance");

  // Pin numbers must be derived from the mappable subset only, in the same
  // order CarparkMap uses — otherwise the badge on a card points at a
  // different pin than the one on the map. Keyed by id, so re-sorting the list
  // below never desyncs a card's number from its map pin.
  const mapNumbers = new Map<string, number>();
  data.results
    .filter((r) => r.location !== null)
    .forEach((r, i) => mapNumbers.set(r.id, i + 1));

  // The nearest car park we can actually price is the yardstick for "is walking
  // further worth it?" — every other priced card is compared against it.
  const benchmark = data.results.reduce<CarparkResult | null>(
    (best, r) =>
      r.fee === null ? best : !best || r.distanceM < best.distanceM ? r : best,
    null,
  );

  // The server returns results nearest-first. Re-sort a copy for display.
  // Cheapest-first puts free ($0) at the top and rate-unknown ("—") at the
  // bottom, since a price we don't know can't be compared.
  const sorted = [...data.results].sort((a, b) => {
    if (sortBy === "price") {
      if (a.fee === null && b.fee === null) return a.distanceM - b.distanceM;
      if (a.fee === null) return 1;
      if (b.fee === null) return -1;
      return a.fee - b.fee || a.distanceM - b.distanceM;
    }
    return a.distanceM - b.distanceM;
  });

  return (
    <section>
      <div className="mb-3">
        <p className="font-medium">{data.destination.name}</p>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {data.destination.address}
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
          {data.startLabel} · {formatDuration(data.minutes)} ·{" "}
          <span style={{ color: dayTypeColour(data.dayType) }}>
            {dayTypeLabel(data.dayType)}
          </span>
          {data.holidayName && ` (${data.holidayName})`}
        </p>
      </div>

      {!data.destinationRateFound && (
        <NoRatePrompt
          destination={data.destination}
          llmEnabled={data.llmEnabled}
          lookupBusy={lookupBusy}
          onWebLookup={onWebLookup}
          onSaved={onRateSaved}
        />
      )}

      <CarparkMap data={data} />

      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          Sort by
        </span>
        {([
          ["distance", "Distance"],
          ["price", "Price"],
        ] as const).map(([key, label]) => {
          const active = sortBy === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSortBy(key)}
              aria-pressed={active}
              className="rounded-lg border px-3 py-1 text-xs font-medium transition-colors"
              style={{
                background: active ? "var(--accent)" : "var(--surface)",
                borderColor: active ? "var(--accent)" : "var(--border)",
                color: active ? "#fff" : "var(--text)",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <ul className="flex flex-col gap-3">
        {sorted.map((r) => (
          <CarparkCard
            key={r.id}
            r={r}
            index={mapNumbers.get(r.id) ?? null}
            llmEnabled={data.llmEnabled}
            benchmark={benchmark}
            onLookedUp={onRateSaved}
          />
        ))}
      </ul>

      <details className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
        <summary className="cursor-pointer">How accurate is this?</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
          {data.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * Shown when the searched destination has no parking rate of its own. Explains
 * that the nearby carparks below are what we have, and offers the two ways to
 * fill the gap: add a rate by hand, or search the public web for it. The web
 * search is only ever started from here (or the per-card button) — never
 * automatically.
 */
function NoRatePrompt({
  destination,
  llmEnabled,
  lookupBusy,
  onWebLookup,
  onSaved,
}: {
  destination: SearchResponse["destination"];
  llmEnabled: boolean;
  lookupBusy: boolean;
  onWebLookup: () => void;
  onSaved: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div
      className="mb-4 rounded-xl border p-4"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <p className="text-sm font-medium">
        No rates for {destination.name} yet
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        We don&apos;t have parking rates for this exact location. The nearby
        carparks and their rates are listed below — or fill the gap here:
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {llmEnabled && (
          <button
            type="button"
            onClick={onWebLookup}
            disabled={lookupBusy}
            className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            {lookupBusy ? "Searching the web…" : "🔎 Search the web for its rate"}
          </button>
        )}
        {llmEnabled &&
          (addOpen ? (
            <AddRatePanel
              target={destTarget(destination)}
              onSaved={onSaved}
              onClose={() => setAddOpen(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="text-left text-[11px] font-medium underline underline-offset-2"
              style={{ color: "var(--accent)" }}
            >
              ✨ Add a rate
            </button>
          ))}
      </div>
    </div>
  );
}

/** RateTarget for the searched destination itself. */
function destTarget(d: SearchResponse["destination"]): RateTarget {
  return {
    matchType: d.postal ? "postal" : "name",
    matchValue: d.postal ?? d.name,
    displayName: d.name,
    lat: d.location.lat,
    lng: d.location.lng,
  };
}

/** RateTarget for a specific car park card in the results list. */
function cardTarget(r: CarparkResult): RateTarget {
  return {
    matchType: "name",
    matchValue: r.name,
    displayName: r.name,
    lat: r.location?.lat ?? null,
    lng: r.location?.lng ?? null,
  };
}

/**
 * Where an added rate should be attached: a specific car park card in the
 * list, or the searched destination itself.
 */
interface RateTarget {
  matchType: "postal" | "name";
  matchValue: string;
  displayName: string;
  lat: number | null;
  lng: number | null;
}

/**
 * Add a rate for a car park with the LLM's help — no manual keying. Either
 * paste a link (we fetch and read the page) or paste the rate text copied from
 * the operator's site (the path for JavaScript sites whose rates never appear
 * in fetched HTML). The extracted rate is saved directly, then shows on the
 * card so it can be eyeballed and re-done if it's off.
 */
function AddRatePanel({
  target,
  onSaved,
  onClose,
}: {
  target: RateTarget;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"auto" | "url" | "text">("auto");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Auto query: let the server search the public web for this car park's rate.
  async function runAuto() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: target.displayName,
          postal: target.matchType === "postal" ? target.matchValue : null,
          lat: target.lat,
          lng: target.lng,
          force: true,
        }),
      });
      const body = await res.json();
      if (res.ok && body.found) {
        setMsg({ ok: true, text: "Found and saved a rate." });
        setTimeout(() => {
          onClose();
          onSaved();
        }, 1200);
      } else if (body.status === "error") {
        setMsg({ ok: false, text: body.reason ?? "Web lookup failed." });
      } else {
        setMsg({ ok: false, text: body.reason ?? "No rate found online." });
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  async function extractAndSave() {
    if (!value.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const ex = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: mode, value: value.trim() }),
      }).then((r) => r.json());
      if (!ex.found) {
        setMsg({ ok: false, text: ex.reason ?? "Couldn't find a rate in that." });
        return;
      }
      const res = await fetch("/api/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchType: target.matchType,
          matchValue: target.matchValue,
          displayName: ex.carparkName || target.displayName,
          weekdayRate: ex.weekdayRate,
          saturdayRate: ex.saturdayRate ?? null,
          sundayPhRate: ex.sundayPhRate ?? null,
          // Keep the link the user pasted as the source, else one the AI spotted.
          sourceUrl: (mode === "url" ? value.trim() : ex.sourceUrl) || null,
          notes: ex.notes || null,
          // AI-parsed, so labelled AI-retrieved ("verify") in the UI.
          source: "web-llm",
          lat: target.lat,
          lng: target.lng,
        }),
      });
      if (!res.ok) {
        const b = await res.json();
        setMsg({ ok: false, text: b.error ?? "Could not save the rate." });
        return;
      }
      setMsg({ ok: true, text: `Saved: ${ex.weekdayRate}` });
      setValue("");
      // Let the confirmation show briefly, then refresh so the rate appears.
      setTimeout(() => {
        onClose();
        onSaved();
      }, 1400);
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    background: "var(--surface)",
    borderColor: "var(--border)",
    color: "var(--text)",
  };

  const submit = mode === "auto" ? runAuto : extractAndSave;
  const submitLabel = busy
    ? mode === "auto"
      ? "Searching the web…"
      : mode === "url"
        ? "Reading the page…"
        : "Reading the rates…"
    : mode === "auto"
      ? "Auto query"
      : "Extract & save";
  const submitDisabled = busy || (mode !== "auto" && !value.trim());

  return (
    <div
      className="mt-2 rounded-lg border p-3"
      style={{ borderColor: "var(--border)", background: "var(--bg)" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium">✨ Add a rate</span>
        <div className="ml-auto flex gap-1">
          {([
            ["auto", "Auto query"],
            ["url", "From a link"],
            ["text", "Paste rates"],
          ] as const).map(([key, label]) => {
            const active = mode === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setMode(key);
                  setMsg(null);
                }}
                aria-pressed={active}
                className="rounded-md border px-2 py-1 text-[11px] font-medium"
                style={{
                  background: active ? "var(--accent)" : "var(--surface)",
                  borderColor: active ? "var(--accent)" : "var(--border)",
                  color: active ? "#fff" : "var(--text)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {mode === "auto" ? (
        <p className="text-[11px]" style={{ color: "var(--muted)" }}>
          Auto query searches the public web for this car park&apos;s official
          rates and fills them in for you. It&apos;s AI-assisted, so double-check
          the result on the card before relying on it.
        </p>
      ) : mode === "url" ? (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://operator-site/parking-rates"
          className="w-full rounded-lg border px-3 py-2 text-sm"
          style={inputStyle}
        />
      ) : (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          placeholder="Paste the rates copied from the operator's site…"
          className="w-full rounded-lg border px-3 py-2 text-sm"
          style={inputStyle}
        />
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitDisabled}
          className="flex-1 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            setMsg(null);
          }}
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          Cancel
        </button>
      </div>

      {msg && (
        <p
          className="mt-2 text-[11px]"
          style={{ color: msg.ok ? "#22c55e" : "#d97706" }}
        >
          {msg.text}
        </p>
      )}
      {mode !== "auto" && (
        <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
          The AI reads the rate and saves it — check it on the card afterwards.
        </p>
      )}
    </div>
  );
}

function CarparkCard({
  r,
  index,
  llmEnabled,
  benchmark,
  onLookedUp,
}: {
  r: CarparkResult;
  index: number | null;
  llmEnabled: boolean;
  /** Nearest priced car park, to compare cost against. Null if none priced. */
  benchmark: CarparkResult | null;
  /** Re-run the search after a lookup saves a rate, so the new rate shows. */
  onLookedUp: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // Fraction of lots FREE, not occupied. Named explicitly because "3/4" was
  // ambiguous enough to read as either.
  const freeRatio =
    r.lotsAvailable !== null && r.totalLots
      ? r.lotsAvailable / r.totalLots
      : null;

  return (
    <li
      className="rounded-xl border p-4"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2">
          {index !== null && (
            <span
              aria-hidden
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
              style={{ background: badgeColour(freeRatio) }}
            >
              {index}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {r.distanceIsWalking ? "walk" : "approx"}{" "}
              {formatDistance(r.distanceM)} · {formatWalkMinutes(r.distanceM)}
              {/* Shelter is only known for HDB carparks; hide the "unknown"
                  placeholder on commercial/EPS ones rather than guessing. */}
              {r.shelter && r.shelter !== "unknown" && ` · ${r.shelter}`}
              {r.needsParkingApp && " · parking.sg"}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          {r.fee !== null ? (
            <>
              <p className="font-semibold">{formatFee(r.fee)}</p>
              {r.feeConfidence !== "high" && (
                <p
                  className="text-[10px] uppercase"
                  style={{ color: "#d97706" }}
                >
                  {r.feeConfidence}
                </p>
              )}
              <TradeOff r={r} benchmark={benchmark} />
            </>
          ) : llmEnabled && !rateIsFromLiveApi(r) ? (
            <button
              type="button"
              onClick={() => setAddOpen((o) => !o)}
              aria-expanded={addOpen}
              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              ＋ Add rate
            </button>
          ) : (
            <p className="font-semibold">{formatFee(r.fee)}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {freeRatio === null && r.lotsAvailable !== null ? (
          // Live count with no capacity behind it (DataMall reports free lots
          // only). A bar would need a total, so show the number alone.
          <span
            className="text-xs font-medium tabular-nums"
            style={{ color: r.lotsAvailable === 0 ? "#ef4444" : "#22c55e" }}
          >
            {r.lotsAvailable === 0 ? "Full" : `${r.lotsAvailable} lots free`}
          </span>
        ) : freeRatio === null ? (
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            No live lot data
          </span>
        ) : (
          <>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full"
              style={{ background: "var(--border)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, freeRatio * 100)}%`,
                  background: lotColour(freeRatio),
                }}
              />
            </div>
            <span
              className="shrink-0 text-xs font-medium tabular-nums"
              style={{ color: lotColour(freeRatio) }}
            >
              {r.lotsAvailable === 0 ? "Full" : `${r.lotsAvailable} free`}
            </span>
            {/* Suppressed when full, otherwise it reads "Full of 20". */}
            {r.lotsAvailable !== 0 && (
              <span
                className="shrink-0 text-[11px] tabular-nums"
                style={{ color: "var(--muted)" }}
              >
                of {r.totalLots}
              </span>
            )}
          </>
        )}
      </div>

      {r.location && (
        <NavigateButton lat={r.location.lat} lng={r.location.lng} />
      )}
      {r.needsParkingApp && (
        <div className="mt-2">
          <ParkingSgButton />
        </div>
      )}

      {/* No rate yet: the "＋ Add rate" price button opens this panel. */}
      {r.fee === null && llmEnabled && !rateIsFromLiveApi(r) && addOpen && (
        <AddRatePanel
          target={cardTarget(r)}
          onSaved={onLookedUp}
          onClose={() => setAddOpen(false)}
        />
      )}

      {r.feeNote && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
          {r.feeNote}
        </p>
      )}

      <p className="mt-1 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--muted)" }}>
        <span>{feeSourceLabel(r)}</span>
        {browsableSourceUrl(r.feeSourceUrl) && (
          <a
            href={browsableSourceUrl(r.feeSourceUrl)!}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
            style={{ color: "var(--accent)" }}
          >
            source
          </a>
        )}
      </p>

      {(r.feeBreakdown.length > 0 ||
        (r.fee !== null && llmEnabled && !rateIsFromLiveApi(r))) && (
        <details className="mt-2">
          <summary
            className="cursor-pointer text-[11px] font-medium"
            style={{ color: "var(--accent)" }}
          >
            How this fee is worked out
          </summary>
          {r.feeBreakdown.length > 0 && (
            <dl
              className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-3 text-[11px]"
              style={{ borderColor: "var(--border)" }}
            >
              {r.feeBreakdown.map((row, i) => {
                const isTotal = row.label === "Total";
                return (
                  <div key={i} className="contents">
                    <dt style={{ color: "var(--muted)" }}>{row.label}</dt>
                    <dd
                      className="text-right tabular-nums"
                      style={{
                        color: isTotal ? "var(--text)" : "var(--muted)",
                        fontWeight: isTotal ? 600 : 400,
                      }}
                    >
                      {row.value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          {r.fee !== null && llmEnabled && !rateIsFromLiveApi(r) && (
            <div className="mt-2">
              {addOpen ? (
                <AddRatePanel
                  target={cardTarget(r)}
                  onSaved={onLookedUp}
                  onClose={() => setAddOpen(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="text-[11px] font-medium underline underline-offset-2"
                  style={{ color: "var(--accent)" }}
                >
                  ✨ Add or update this rate
                </button>
              )}
            </div>
          )}
        </details>
      )}
    </li>
  );
}

/**
 * True when the card's RATE comes straight from an official live API — HDB's
 * current rate schedule (data.gov.sg) or URA's Car Park Details API. Those are
 * already authoritative, so no web re-lookup button is offered for them. Every
 * other source (stale LTA dataset, scraped operator pages, manual, AI) can be
 * refreshed from the web.
 */
function rateIsFromLiveApi(r: CarparkResult): boolean {
  if (r.feeSource === "hdb-schedule") return true;
  // URA rates are imported as "operator-site"; tell them apart from the LTA
  // OneMotoring scrape (also "operator-site") by their Data Service source URL.
  if (r.feeSource === "operator-site" && isUraApiUrl(r.feeSourceUrl)) {
    return true;
  }
  return false;
}

/** True for URA's Data Service endpoint — an API, not a human-viewable page. */
function isUraApiUrl(url: string | null): boolean {
  return Boolean(url && url.includes("uraDataService"));
}

/**
 * True for LTA's open carpark-rates dataset on data.gov.sg. Worth its own label
 * rather than "operator site": it is a published dataset that stopped being
 * updated in June 2024, and the age beside it is doing real work.
 */
function isOpenDataUrl(url: string | null): boolean {
  return Boolean(url && url.includes("data.gov.sg"));
}

/**
 * True for LTA's OneMotoring portal. Both URA and OneMotoring rates are stored
 * as "operator-site", but OneMotoring is a government aggregator that re-lists
 * operators' rates — not the operator's own site — so it gets its own label and
 * remains eligible for a user-triggered web refresh.
 */
function isOneMotoringUrl(url: string | null): boolean {
  return Boolean(url && url.includes("onemotoring.lta.gov.sg"));
}

/**
 * The URL to link "source" to, or null to show no link. URA's Data Service
 * endpoint returns a JSON API error in a browser rather than a rate page, so
 * it's shown as a plain label with no link.
 */
function browsableSourceUrl(url: string | null): string | null {
  if (!url || isUraApiUrl(url)) return null;
  return url;
}

function feeSourceLabel(r: CarparkResult): string {
  const age = ageLabel(r.feeVerifiedAt);
  switch (r.feeSource) {
    case "hdb-schedule":
      return "HDB rate schedule (current)";
    case "lta-dataset":
      return `LTA dataset · ${age}`;
    case "manual":
      return `Your rate · ${age}`;
    case "web-llm":
      return `AI-retrieved · ${age} · verify`;
    case "eps-inventory":
      return "LTA EPS listing · no rate yet";
    case "operator-site":
      // "operator-site" is really three sources; separate them so the label
      // matches how authoritative each is.
      if (isUraApiUrl(r.feeSourceUrl)) return `URA (official) · ${age}`;
      if (isOpenDataUrl(r.feeSourceUrl)) return `LTA open dataset · ${age}`;
      if (isOneMotoringUrl(r.feeSourceUrl)) return `Via LTA OneMotoring · ${age}`;
      return `From operator site · ${age}`;
  }
}

/** "verified today" / "3 days ago" / "~2 years old" from an ISO date. */
function ageLabel(iso: string | null): string {
  if (!iso) return "undated";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "undated";
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "verified today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months old`;
  const years = (days / 365).toFixed(days < 730 ? 1 : 0);
  return `~${years} ${Number(years) === 1 ? "year" : "years"} old`;
}

function lotColour(freeRatio: number): string {
  if (freeRatio < 0.05) return "#ef4444";
  if (freeRatio < 0.2) return "#f59e0b";
  return "#22c55e";
}

/** Must match availabilityColour() in CarparkMap so pins and badges agree. */
function badgeColour(freeRatio: number | null): string {
  return freeRatio === null ? "#6b7280" : lotColour(freeRatio);
}

/**
 * "Save $2.40 · 4 min further" — what this car park costs relative to the
 * nearest one we can price, so the extra walk can be judged against the money.
 * Hidden on the benchmark itself, and when the saving rounds to nothing.
 */
function TradeOff({
  r,
  benchmark,
}: {
  r: CarparkResult;
  benchmark: CarparkResult | null;
}) {
  if (!benchmark || benchmark.id === r.id || r.fee === null) return null;

  const diff = r.fee - benchmark.fee!;
  const walkDiff =
    Math.round(r.distanceM / 80) - Math.round(benchmark.distanceM / 80);
  if (Math.abs(diff) < 0.01) return null;

  const cheaper = diff < 0;
  const money = `${cheaper ? "Save" : "+"} $${Math.abs(diff).toFixed(2)}`;
  // Only mention the walk when it actually differs; nearer AND cheaper needs no
  // trade-off framing at all.
  const walk =
    walkDiff > 0
      ? ` · ${walkDiff} min further`
      : walkDiff < 0
        ? ` · ${Math.abs(walkDiff)} min closer`
        : "";

  return (
    <p
      className="text-[10px]"
      style={{ color: cheaper ? "#22c55e" : "var(--muted)" }}
    >
      {money}
      {walk}
    </p>
  );
}

/** Rough walking time from distance at ~5 km/h (≈80 m/min). */
function formatWalkMinutes(distanceM: number): string {
  return `~${Math.max(1, Math.round(distanceM / 80))} min`;
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/**
 * "Saturday, 8 Aug · Saturday rates" for a datetime-local value.
 *
 * The value is a naive local string the app reads as Singapore time, so the
 * date parts are used as-is (built in UTC) rather than parsed as a Date, which
 * would shift the day on a device in another timezone.
 *
 * Saturday and Sunday get the rate band named because that's the whole reason
 * the day matters. Weekdays deliberately don't: a weekday can still be a public
 * holiday, and only the server knows the holiday list — the results header
 * reports the band that was actually applied.
 */
function describeStart(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(date.getTime())) return "";
  const dow = date.getUTCDay();
  const label = `${DAY_NAMES[dow]}, ${d} ${MONTH_NAMES[mo - 1]}`;
  if (dow === 6) return `${label} · Saturday rates`;
  if (dow === 0) return `${label} · Sunday / public holiday rates`;
  return label;
}

/** Longest session the fee engine prices; caps are per-day, so beyond this the
 *  number stops being meaningful. */
const MAX_DURATION_MIN = 24 * 60;

/** Minutes from the custom-duration input (a number + unit), clamped 1min–24h. */
function customMinutes(val: string, unit: "min" | "hr"): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const mins = unit === "hr" ? Math.round(n * 60) : Math.round(n);
  return Math.max(1, Math.min(MAX_DURATION_MIN, mins));
}

/** True when the typed duration is longer than we price, so the UI can say so
 *  instead of silently showing "= 24h". */
function exceedsDurationMax(val: string, unit: "min" | "hr"): boolean {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return false;
  return (unit === "hr" ? n * 60 : n) > MAX_DURATION_MIN;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function dayTypeLabel(d: SearchResponse["dayType"]): string {
  if (d === "sunday-ph") return "Sunday / public holiday rates";
  if (d === "saturday") return "Saturday rates";
  // Most car parks bill Friday as a weekday; a few price it with the weekend,
  // so name it rather than implying every Friday costs more.
  if (d === "friday") return "Friday rates";
  return "weekday rates";
}

function dayTypeColour(d: SearchResponse["dayType"]): string {
  return d === "weekday" ? "var(--muted)" : "#22c55e";
}
