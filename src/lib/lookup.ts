import { z } from "zod";
import { generateObjectFallback, isLlmConfigured } from "./llm";
import { webSearch, isSearchConfigured } from "./websearch";
import {
  upsertOverride,
  findOverrideForDestination,
  findOverlappingOverride,
  type RateOverride,
} from "./store/rates";
import { resolveGapsByName } from "./store/gaps";
import { parseRate, bandForTime, estimateMallFee, parseLimits } from "./sources/mallRates";
import { citedUrl } from "./citation";
import { checkLocation } from "./geo";
import { rankCitations, allBlocked } from "./sourceQuality";
import { geocode } from "./onemap";

/**
 * Can the fee engine actually turn this string into a number?
 *
 * Checked at four arrival hours because a rate with clock bands prices in some
 * and not others, and one probe cannot tell "no night band" from "does not
 * parse at all".
 */
function pricesAtSomeHour(rate: string): boolean {
  return [8, 13, 20, 1].some((h) => {
    const band = bandForTime(rate, h * 60);
    const fee = estimateMallFee(parseRate(band), 120, parseLimits(band));
    return fee !== null;
  });
}

/**
 * Extracted rate shape. Rate strings deliberately match the LTA-dataset text
 * form (e.g. "$1.20 per half hour") so they flow through the SAME parser and
 * time-aware fee engine as every other rate — no special-casing downstream.
 */
export const RateExtraction = z.object({
  found: z
    .boolean()
    .describe("true only if concrete public parking rates were found"),
  confidence: z.enum(["high", "medium", "low"]),
  carparkName: z.string().nullable(),
  operator: z.string().nullable(),
  weekdayRate: z
    .string()
    .nullable()
    .describe('e.g. "$1.20 per half hour" or "$2 for 1st hr; $1 per 30 mins"'),
  fridayRate: z
    .string()
    .nullable()
    .describe(
      "only when the operator prices Friday differently from Mon-Thu (several " +
        "malls bill Fri-Sun as the weekend); null if Friday is an ordinary weekday",
    ),
  saturdayRate: z.string().nullable(),
  sundayPhRate: z.string().nullable(),
  carparkAddress: z
    .string()
    .nullable()
    .describe(
      "the street address or 6-digit postal code of the carpark these rates " +
        "are for, exactly as the source states it; null if the source never " +
        "says. Do NOT infer it from the name you were asked about",
    ),
  sourceUrl: z
    .string()
    .nullable()
    .describe("the single most authoritative URL, ideally the operator's site"),
  notes: z.string().nullable().describe("caveats: grace periods, min-spend, etc."),
});

export interface LookupResult {
  found: boolean;
  /** "not-found" = searched, nothing found. "error" = the call itself failed. */
  status: "found" | "not-found" | "error" | "disabled";
  reason?: string;
  override?: RateOverride;
  sources: string[];
}

/** Turns a provider error into a message that explains the real cause. */
export function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no longer available|not found|404/i.test(msg)) {
    return "The configured model is unavailable for this API key. Set LLM_MODEL to a current model (e.g. gemini-flash-latest).";
  }
  if (/tavily/i.test(msg)) {
    return `Web search failed (${msg}). Check TAVILY_API_KEY and your Tavily quota.`;
  }
  if (/quota|rate.?limit|429/i.test(msg)) {
    return "Model quota exceeded — wait a bit, or set LLM_MODEL to another free model.";
  }
  return `Web lookup failed: ${msg}`;
}

/**
 * Looks up a carpark's current rates on the web via an LLM with Google Search
 * grounding, extracts them, and saves them as a 'web-llm' override (clearly
 * labelled in the UI as AI-retrieved so the user knows to sanity-check).
 */
export async function lookupCarparkRate(args: {
  /**
   * Extra address text for the SEARCH QUERY only — never for identity.
   * EPS files a handful of carparks under an opaque code ("TLF", "BTC / NUS"),
   * and searching that alone finds nothing. The street address is the only
   * usable handle those have. It is not used to match or name anything.
   */
  addressHint?: string | null;
  destination: string;
  postal: string | null;
  /** The destination's coordinates, stored so the saved rate is spatially matchable. */
  lat?: number | null;
  lng?: number | null;
  /**
   * Re-search even when a rate already exists (the per-carpark "search the web"
   * button). A hand-entered manual rate is still protected — we never let an
   * AI-retrieved rate clobber one the user typed in themselves.
   */
  force?: boolean;
}): Promise<LookupResult> {
  if (!isLlmConfigured()) {
    return { found: false, status: "disabled", reason: "LLM is not configured.", sources: [] };
  }
  if (!isSearchConfigured()) {
    return {
      found: false,
      status: "disabled",
      reason: "Web search (TAVILY_API_KEY) is not configured.",
      sources: [],
    };
  }

  // Don't spend a lookup on something we already have — unless the caller
  // explicitly forced a refresh. Even then, never overwrite a rate the user
  // typed in themselves; return it untouched.
  const existing = findOverrideForDestination({
    postal: args.postal,
    name: args.destination,
    lat: args.lat,
    lng: args.lng,
  });
  if (existing && (!args.force || existing.source === "manual")) {
    return { found: true, status: "found", override: existing, sources: [] };
  }

  let sources: string[] = [];
  try {
    // Step 1 — web search (Tavily). Bias the query toward official rate pages.
    // The street address, not just the postal, decides which pages come back.
    // Searching "MOE (Evans Road) … 259366" returned a streetdirectory listing
    // with no prices on it; adding "21 Evans Road" surfaced
    // parkopedia's page for that exact carpark, which quotes them. The
    // citation can only be as good as the results, so this is upstream of
    // every ranking rule.
    //
    // Resolved here rather than threaded through each caller: the API route
    // takes its address from the client and the scripts geocode separately, so
    // one lookup in one place keeps them consistent. OneMap is free and this
    // path already spends a paid search and an LLM call.
    const hint =
      args.addressHint ??
      (await geocode(args.destination).catch(() => null))?.address ??
      null;
    const query =
      `${args.destination} ` +
      (hint ? `${hint} ` : "") +
      `Singapore car park parking rates per hour` +
      (args.postal ? ` ${args.postal}` : "");
    const hits = await webSearch(query, 6);
    sources = hits.map((h) => h.url);

    if (hits.length === 0) {
      return {
        found: false,
        status: "not-found",
        reason: "No web results for this destination.",
        sources,
      };
    }

    const research = hits
      .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`)
      .join("\n\n---\n\n");

    // Step 2 — structured extraction from the search results (no tools).
    const { object } = await generateObjectFallback({
      op: "rate-lookup",
      schema: RateExtraction,
      prompt:
        `From the web search results below, extract the CURRENT public car ` +
        `parking rates for "${args.destination}" in Singapore.\n` +
        `Only set found=true if the results genuinely contain parking rates ` +
        `for THIS carpark/building (not a different one). Prefer the ` +
        `operator's own official page and pick that as the source URL. Copy ` +
        `that URL verbatim from the list below — never construct, guess or ` +
        `tidy one.\n` +
        `Also report the carpark's own address or postal code as the source ` +
        `states it, so it can be checked against the place asked for.\n` +
        // Identity by name is what produced every wrong-carpark save we have
        // had. Asked about MOE HQ (Evans Road) the model held a source giving
        // 21 Evans Road — which IS MOE HQ — with a rate, and refused anyway
        // for want of "a definitive source using the exact name". It threw
        // away the strong signal because the weak one was imperfect.
        `Identify the carpark by ADDRESS, not by name. Every aggregator names ` +
        `the same carpark differently, and genuinely different carparks share ` +
        `names, so a source whose ADDRESS matches the place asked about is ` +
        `stronger evidence than one whose name matches.\n` +
        `Do not lower confidence merely because sources word the name ` +
        `differently, or because one of several agreeing sources cites a ` +
        `neighbouring address. If a source with the right address states a ` +
        `rate, that is enough. Reserve low confidence for a real conflict in ` +
        `the RATE, or for results that are all about a different place.\n` +
        `Rate strings must be concise and machine-parseable, like ` +
        `"$1.20 per half hour" or "$2 for 1st hr; $1 per 30 mins", or null if ` +
        `unknown.\n\n` +
        `Results:\n${research}`,
    });

    if (!object.found || !object.weekdayRate || object.confidence === "low") {
      return {
        found: false,
        status: "not-found",
        reason: object.notes ?? "No reliable current rate found online.",
        sources,
      };
    }

    // A rate we cannot price is worse than no rate at all. It renders "not
    // computable" beside a confident-looking string, and — because the row now
    // exists — the carpark counts as covered, so no later sweep or bulk run
    // ever retries it. Refuse it here, where the cost is one wasted lookup,
    // rather than discovering it in an audit weeks later.
    //
    // Only the weekday column gates the save. A model that produced an
    // unpriceable weekday string got the extraction wrong; a Saturday column
    // that cannot price is a narrower fault, and dropping it would be worse
    // than keeping it — the day fallback would quietly show weekday prices on
    // a Sunday that genuinely differs.
    if (!pricesAtSomeHour(object.weekdayRate)) {
      return {
        found: false,
        status: "not-found",
        reason:
          `Extracted a weekday rate the fee engine cannot price, so it was ` +
          `not saved: "${object.weekdayRate}". Worth adding to the parser ` +
          `tests if the format looks legitimate.`,
        sources,
      };
    }

    // Two rates in one day were saved against the wrong building: MOE (Evans
    // Road) got MOE Building's rates from Buona Vista, 3.5 km away, and
    // Midview Building got Midview City's from 13 km away. Both times the
    // destination had been geocoded correctly and the answer was already in
    // hand — nothing ever compared the two.
    //
    // A wrong rate under a confident name is worse than no rate: it also marks
    // the carpark as covered, so no sweep or bulk run retries it. Refuse here,
    // where it costs one lookup.
    // Evidence first, reputation second. Re-citing MOE (Evans Road) from a
    // free-hosting carpark directory to streetdirectory.com looked like an
    // upgrade and was the opposite: streetdirectory's page carries no dollar
    // amount at all, while the page it replaced states the rate outright. A
    // citation nobody can follow to the number is not a citation.
    //
    // Blogs are still dropped entirely — Singapore Botanic Gardens came from a
    // personal WordPress post whose rate contradicted itself — and a result set
    // that is nothing but blogs is refused rather than cited.
    const citable = rankCitations(hits.map((h) => ({ url: h.url, content: h.content })));
    if (!citable.length || allBlocked(hits.map((h) => ({ url: h.url })))) {
      return {
        found: false,
        status: "not-found",
        reason:
          `Every result was a blog, forum or other self-published page, so ` +
          `there is no source worth citing for a price. Not saved.`,
        sources,
      };
    }

    const foundAt = object.carparkAddress ? await geocode(object.carparkAddress).catch(() => null) : null;
    const where = checkLocation(
      args.lat != null && args.lng != null ? { lat: args.lat, lng: args.lng } : null,
      foundAt?.location ?? null,
    );
    if (!where.ok) {
      return {
        found: false,
        status: "not-found",
        reason:
          `The rates found are for "${object.carparkAddress}", ` +
          `${(where.metres / 1000).toFixed(1)} km from "${args.destination}" — ` +
          `almost certainly a different carpark with a similar name, so it was ` +
          `not saved.`,
        sources,
      };
    }

    // One car park, one row. upsertOverride keys on a NAME, so the same
    // basement reached under a second name becomes a second row: Oxley Tower
    // ended up with "OXLEYTOWER" at $3.50 and "OXLEYTOWERBASEMENTCARPARK" at
    // $15.00, both saved the same day from the same geocode. Refusing costs one
    // lookup; the duplicate costs a driver four times the price and is invisible
    // until someone reads two cards side by side.
    const savingKey = {
      matchType: args.postal ? "postal" : "name",
      matchValue: args.postal ?? args.destination,
    };
    const clash =
      args.lat != null && args.lng != null
        ? findOverlappingOverride({ lat: args.lat, lng: args.lng }, savingKey)
        : null;
    if (clash) {
      return {
        found: false,
        status: "not-found",
        reason:
          `A rate for this place is already saved as "${clash.displayName ?? clash.matchValue}" ` +
          `(#${clash.id}). Saving this would create a second row for one car park, ` +
          `so it was not saved — update that one instead.`,
        sources,
      };
    }

    const override = upsertOverride({
      // Postal is the stable key when we have it; else the (normalized) name.
      matchType: args.postal ? "postal" : "name",
      matchValue: args.postal ?? args.destination,
      displayName: object.carparkName ?? args.destination,
      weekdayRate: object.weekdayRate,
      fridayRate: object.fridayRate,
      saturdayRate: object.saturdayRate,
      sundayPhRate: object.sundayPhRate,
      source: "web-llm",
      sourceUrl: citedUrl(object.sourceUrl, citable),
      verifiedAt: new Date().toISOString().slice(0, 10),
      lat: args.lat ?? null,
      lng: args.lng ?? null,
      notes: object.notes
        ? `AI-retrieved — verify. ${object.notes}`
        : "AI-retrieved from the web — verify before relying on it.",
    });
    resolveGapsByName(override.displayName ?? override.matchValue);

    return { found: true, status: "found", override, sources };
  } catch (err) {
    // Surface the real cause (retired model, grounding quota) instead of
    // letting the route swallow it as a generic "no rate found".
    console.error("lookup provider error", err);
    return { found: false, status: "error", reason: classifyError(err), sources };
  }
}
