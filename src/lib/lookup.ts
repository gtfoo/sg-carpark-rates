import { z } from "zod";
import { generateObjectFallback, isLlmConfigured } from "./llm";
import { webSearch, isSearchConfigured } from "./websearch";
import {
  upsertOverride,
  findOverrideForDestination,
  type RateOverride,
} from "./store/rates";
import { resolveGapsByName } from "./store/gaps";

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
  });
  if (existing && (!args.force || existing.source === "manual")) {
    return { found: true, status: "found", override: existing, sources: [] };
  }

  let sources: string[] = [];
  try {
    // Step 1 — web search (Tavily). Bias the query toward official rate pages.
    const query =
      `${args.destination} Singapore car park parking rates per hour` +
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
        `operator's own official page and pick that as the source URL.\n` +
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
      sourceUrl: object.sourceUrl ?? sources[0] ?? null,
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
