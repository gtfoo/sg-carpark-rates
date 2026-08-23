/**
 * Web search, abstracted so the provider is a config choice.
 *
 * Gemini's own Google Search grounding needs a billing-enabled project, so on
 * the free tier we do the searching with a dedicated search API (Tavily: free,
 * no credit card) and hand the results to the LLM only for extraction.
 *
 *   SEARCH_PROVIDERS  ordered, comma-separated fallback chain, e.g.
 *                     "tavily,brave". The first provider holding a key is
 *                     tried; on quota, rate-limit or outage the next is used.
 *   SEARCH_PROVIDER   single provider when SEARCH_PROVIDERS is unset
 *   TAVILY_API_KEY    free key from https://tavily.com
 *   BRAVE_API_KEY     free key from https://brave.com/search/api
 *
 * **Search had no fallback at all until 2026-08-18.** One hardcoded provider:
 * when Tavily's quota went, every lookup died at its first call and the feature
 * was simply gone. Extraction had a chain and search did not, which left the
 * app only as available as its least redundant dependency.
 */

import { recordUsage } from "./usage";

export interface SearchHit {
  title: string;
  url: string;
  /** Snippet or extracted page text — the material the LLM extracts rates from. */
  content: string;
}

/** Where each search provider's key lives. */
const SEARCH_KEYS: Record<string, string> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
};

/** The ordered providers to try, most-preferred first. */
export function getSearchProviders(): string[] {
  const chain = process.env.SEARCH_PROVIDERS;
  if (chain) {
    const list = chain.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [process.env.SEARCH_PROVIDER ?? "tavily"];
}

export function hasSearchCredentials(provider: string): boolean {
  const key = SEARCH_KEYS[provider];
  return key ? Boolean(process.env[key]) : false;
}

/** Usable while ANY provider in the chain holds a key. */
export function isSearchConfigured(): boolean {
  return getSearchProviders().some(hasSearchCredentials);
}

/**
 * Worth asking a DIFFERENT provider: quota, rate limit, auth, or an outage.
 *
 * Deliberately wider than the LLM equivalent. A search API returning 500 is
 * worth re-asking elsewhere, whereas a malformed prompt would fail identically
 * on every model — so the LLM chain is right to be stricter about what it
 * retries and this one is right to be looser.
 */
function shouldTryNextProvider(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /quota|rate.?limit|429|exhausted|credit|unauthorized|401|403|402|5\d\d|network|fetch failed|timeout/i.test(
    m,
  );
}

/**
 * Searches with the first credentialed provider, falling through the chain on
 * anything that another provider might survive.
 */
export async function webSearch(query: string, maxResults = 6): Promise<SearchHit[]> {
  const all = getSearchProviders();
  const providers = all.filter(hasSearchCredentials);
  if (!providers.length) {
    throw new Error(
      `No search provider in the chain has credentials. Checked: ${all.join(", ")}.`,
    );
  }

  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    try {
      switch (provider) {
        case "tavily":
          return await tavilySearch(query, maxResults);
        case "brave":
          return await braveSearch(query, maxResults);
        default:
          throw new Error(`Unknown search provider "${provider}". Add it in websearch.ts.`);
      }
    } catch (err) {
      lastErr = err;
      const hasNext = i < providers.length - 1;
      if (hasNext && shouldTryNextProvider(err)) {
        console.warn(
          `Search provider "${provider}" unavailable (${
            err instanceof Error ? err.message : String(err)
          }); falling back to "${providers[i + 1]}".`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function tavilySearch(query: string, maxResults: number): Promise<SearchHit[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set.");

  const depth = "advanced";
  // Tavily bills in credits rather than tokens, so this belongs in `units`.
  // An advanced search costs more than a basic one under their published
  // pricing; it is our estimate, which is why `usd` stays null rather than
  // inventing a rate. If their pricing moves, this constant is what to revisit.
  const credits = depth === "advanced" ? 2 : 1;

  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: depth,
        max_results: maxResults,
        include_raw_content: "text",
      }),
    });
  } catch (err) {
    // Never reached Tavily, so no credits were spent — but still worth a line:
    // a provider that is unreachable otherwise looks exactly like one nobody
    // called.
    await recordUsage({
      provider: "tavily",
      op: "web-search",
      requests: 1,
      units: 0,
      usd: null,
      status: "error",
    });
    throw err;
  }

  await recordUsage({
    provider: "tavily",
    op: "web-search",
    requests: 1,
    // A rejected request is not billed, so only a 2xx spends credits.
    units: res.ok ? credits : 0,
    usd: null,
    status: res.ok ? "ok" : res.status === 429 ? "rate_limited" : "error",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Tavily search failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    results?: {
      title?: string;
      url?: string;
      content?: string;
      raw_content?: string;
    }[];
  };

  return (body.results ?? [])
    .map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      // Prefer full page text (rate tables live there); cap length to bound tokens.
      content: (r.raw_content || r.content || "").slice(0, 2500),
    }))
    .filter((h) => h.url);
}

/**
 * Brave, as the second link in the chain.
 *
 * A weaker substitute on purpose, and worth knowing why: Brave returns search
 * DESCRIPTIONS, not extracted page text, so a rate table living inside a page
 * usually will not be in the snippet. Extraction quality drops accordingly.
 * That is the right trade for a fallback — a thinner result the model may
 * refuse beats no result at all, and `lookupCarparkRate` already declines
 * anything below full confidence rather than guessing from a weak snippet.
 */
async function braveSearch(query: string, maxResults: number): Promise<SearchHit[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY is not set.");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    });
  } catch (err) {
    await recordUsage({
      provider: "brave",
      op: "web-search",
      requests: 1,
      units: 0,
      usd: null,
      status: "error",
    });
    throw err;
  }

  await recordUsage({
    provider: "brave",
    op: "web-search",
    requests: 1,
    // Brave bills per query, and a rejected query is not billed.
    units: res.ok ? 1 : 0,
    usd: null,
    status: res.ok ? "ok" : res.status === 429 ? "rate_limited" : "error",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brave search failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };

  return (body.web?.results ?? [])
    .map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: (r.description ?? "").slice(0, 2500),
    }))
    .filter((h) => h.url);
}
