"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import AddressInput from "./AddressInput";
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
  const [query, setQuery] = useState("");
  const [minutes, setMinutes] = useState(120);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

    setLastTerm(term);
    setLoading(true);
    setError(null);
    setData(null);
    if (!opts.keepLookup) setLookup(null);

    try {
      const startParam =
        useCustomStart && start ? `&start=${encodeURIComponent(start)}` : "";
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(term)}&minutes=${minutes}${startParam}`,
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
        <h1 className="text-2xl font-bold tracking-tight">Carpark SG</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Nearby carparks, rates and live availability
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
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {DURATIONS.map((d) => {
            const active = d.minutes === minutes;
            return (
              <button
                key={d.minutes}
                type="button"
                onClick={() => setMinutes(d.minutes)}
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
        </div>

        <div className="mt-3">
          {!useCustomStart ? (
            <button
              type="button"
              onClick={() => {
                // Seed with the current Singapore time at the moment of the
                // click, not page load.
                setStart(toSgtInputValue(new Date()));
                setUseCustomStart(true);
              }}
              className="text-sm underline underline-offset-2"
              style={{ color: "var(--muted)" }}
            >
              Starting now · change
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-label="Start time (Singapore)"
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
                className="text-sm underline underline-offset-2"
                style={{ color: "var(--muted)" }}
              >
                Now
              </button>
            </div>
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
  // Pin numbers must be derived from the mappable subset only, in the same
  // order CarparkMap uses — otherwise the badge on a card points at a
  // different pin than the one on the map.
  const mapNumbers = new Map<string, number>();
  data.results
    .filter((r) => r.location !== null)
    .forEach((r, i) => mapNumbers.set(r.id, i + 1));

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

      <ul className="flex flex-col gap-3">
        {data.results.map((r) => (
          <CarparkCard
            key={r.id}
            r={r}
            index={mapNumbers.get(r.id) ?? null}
            llmEnabled={data.llmEnabled}
            onLookedUp={onRateSaved}
          />
        ))}
      </ul>

      {/* When the destination already has a rate, keep an entry point to
          correct or update it. The no-rate case shows its own prompt above. */}
      {data.destinationRateFound && (
        <ManualRateForm destination={data.destination} onSaved={onRateSaved} />
      )}

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
        <ManualRateForm destination={destination} onSaved={onSaved} noMargin />
      </div>
    </div>
  );
}

function ManualRateForm({
  destination,
  onSaved,
  noMargin = false,
}: {
  destination: SearchResponse["destination"];
  onSaved: () => void;
  /** Drop the top margin when embedded in the no-rate prompt's button stack. */
  noMargin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(destination.name);
  const [weekday, setWeekday] = useState("");
  const [saturday, setSaturday] = useState("");
  const [sunday, setSunday] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!weekday.trim()) {
      setErr("A weekday rate is required (e.g. \"$1.20 per half hour\").");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Postal is the stable key when available, else the name.
          matchType: destination.postal ? "postal" : "name",
          matchValue: destination.postal ?? destination.name,
          displayName: displayName.trim() || destination.name,
          weekdayRate: weekday.trim(),
          saturdayRate: saturday.trim() || null,
          sundayPhRate: sunday.trim() || null,
          sourceUrl: sourceUrl.trim() || null,
          notes: notes.trim() || null,
          source: sourceUrl.trim() ? "operator-site" : "manual",
          lat: destination.location.lat,
          lng: destination.location.lng,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "Could not save.");
        return;
      }
      setOpen(false);
      // Reset the volatile fields for next time.
      setWeekday("");
      setSaturday("");
      setSunday("");
      setSourceUrl("");
      setNotes("");
      onSaved();
    } catch {
      setErr("Network error.");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = {
    background: "var(--surface)",
    borderColor: "var(--border)",
    color: "var(--text)",
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`w-full rounded-xl border border-dashed py-2.5 text-sm font-medium ${noMargin ? "" : "mt-4"}`}
        style={{ borderColor: "var(--border)", color: "var(--accent)" }}
      >
        ＋ Add a rate for {destination.name}
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className={`rounded-xl border p-4 ${noMargin ? "" : "mt-4"}`}
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <p className="mb-3 text-sm font-medium">Add a rate for {destination.name}</p>

      <div className="flex flex-col gap-2">
        <label className="text-xs" style={{ color: "var(--muted)" }}>
          Name shown
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
        <label className="text-xs" style={{ color: "var(--muted)" }}>
          Weekday rate *
          <input
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
            placeholder="$1.20 per half hour"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
        <div className="flex gap-2">
          <label className="flex-1 text-xs" style={{ color: "var(--muted)" }}>
            Saturday (optional)
            <input
              value={saturday}
              onChange={(e) => setSaturday(e.target.value)}
              placeholder="same if blank"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={inputStyle}
            />
          </label>
          <label className="flex-1 text-xs" style={{ color: "var(--muted)" }}>
            Sunday / PH (optional)
            <input
              value={sunday}
              onChange={(e) => setSunday(e.target.value)}
              placeholder="Free / rate"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={inputStyle}
            />
          </label>
        </div>
        <label className="text-xs" style={{ color: "var(--muted)" }}>
          Source URL (optional)
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://operator-site/parking"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
        <label className="text-xs" style={{ color: "var(--muted)" }}>
          Notes (optional)
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="grace period, min-spend, etc."
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
      </div>

      <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
        Rate format like the datasets: &quot;$1.20 per half hour&quot;, &quot;$2 for 1st
        hr; $1 per 30 mins&quot;, or &quot;Free&quot;.
      </p>

      {err && (
        <p className="mt-2 text-xs" style={{ color: "#fca5a5" }}>
          {err}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="flex-1 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {saving ? "Saving…" : "Save rate"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border px-4 py-2 text-sm"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function CarparkCard({
  r,
  index,
  llmEnabled,
  onLookedUp,
}: {
  r: CarparkResult;
  index: number | null;
  llmEnabled: boolean;
  /** Re-run the search after a lookup saves a rate, so the new rate shows. */
  onLookedUp: () => void;
}) {
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
              {formatDistance(r.distanceM)}
              {" · "}
              {r.shelter}
              {r.needsParkingApp && " · parking.sg"}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-semibold">{formatFee(r.fee)}</p>
          {r.feeConfidence !== "high" && (
            <p className="text-[10px] uppercase" style={{ color: "#d97706" }}>
              {r.feeConfidence}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {freeRatio === null ? (
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

      {llmEnabled && !rateIsFromLiveApi(r) && (
        <CardWebLookup r={r} onLookedUp={onLookedUp} />
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

      {r.feeBreakdown.length > 0 && (
        <details className="mt-2">
          <summary
            className="cursor-pointer text-[11px] font-medium"
            style={{ color: "var(--accent)" }}
          >
            How this fee is worked out
          </summary>
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

/**
 * Per-carpark "search the web for its rate" button. Shown on cards whose rate
 * is NOT from a live official API (see rateIsFromLiveApi) — i.e. stale dataset,
 * scraped, manual or AI rates, where a fresh public-rate lookup is useful.
 * Forces a real search — a saved AI/operator rate is refreshed, a hand-entered
 * manual rate is left untouched by the server.
 */
function CardWebLookup({
  r,
  onLookedUp,
}: {
  r: CarparkResult;
  onLookedUp: () => void;
}) {
  const [state, setState] = useState<
    "idle" | "searching" | "notfound" | "error"
  >("idle");
  const [reason, setReason] = useState<string | null>(null);

  async function search() {
    setState("searching");
    setReason(null);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: r.name,
          postal: null,
          lat: r.location?.lat ?? null,
          lng: r.location?.lng ?? null,
          force: true,
        }),
      });
      const body = await res.json();
      if (res.ok && body.found) {
        // A rate was saved — re-run the search so this card shows it. The card
        // unmounts on refresh, so no local state needs resetting.
        onLookedUp();
      } else if (body.status === "error") {
        setState("error");
        setReason(body.reason ?? "Web lookup failed.");
      } else {
        setState("notfound");
        setReason(body.reason ?? "No rate found online.");
      }
    } catch {
      setState("error");
      setReason("Network error.");
    }
  }

  if (state === "searching") {
    return (
      <p
        className="mt-2 flex items-center gap-2 text-[11px]"
        style={{ color: "var(--muted)" }}
      >
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2"
          style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
        />
        Searching the web for {r.name}&apos;s rate…
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={search}
        className="text-[11px] font-medium underline underline-offset-2"
        style={{ color: "var(--accent)" }}
      >
        {state === "idle" ? "🔎 Search the web for its rate" : "Try again"}
      </button>
      {reason && (
        <span className="ml-2 text-[11px]" style={{ color: "#d97706" }}>
          {reason}
        </span>
      )}
    </div>
  );
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
    case "operator-site":
      // "operator-site" is really three sources; separate them so the label
      // matches how authoritative each is.
      if (isUraApiUrl(r.feeSourceUrl)) return `URA (official) · ${age}`;
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

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
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
  return "weekday rates";
}

function dayTypeColour(d: SearchResponse["dayType"]): string {
  return d === "weekday" ? "var(--muted)" : "#22c55e";
}
