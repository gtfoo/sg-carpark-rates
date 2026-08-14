/**
 * Web search, abstracted so the provider is a config choice.
 *
 * Gemini's own Google Search grounding needs a billing-enabled project, so on
 * the free tier we do the searching with a dedicated search API (Tavily: free,
 * no credit card) and hand the results to the LLM only for extraction.
 *
 *   SEARCH_PROVIDER  tavily (default)
 *   TAVILY_API_KEY   free key from https://tavily.com
 */

import { recordUsage } from "./usage";

export interface SearchHit {
  title: string;
  url: string;
  /** Snippet or extracted page text — the material the LLM extracts rates from. */
  content: string;
}

export function isSearchConfigured(): boolean {
  const provider = process.env.SEARCH_PROVIDER ?? "tavily";
  if (provider === "tavily") return Boolean(process.env.TAVILY_API_KEY);
  return false;
}

export async function webSearch(
  query: string,
  maxResults = 6,
): Promise<SearchHit[]> {
  const provider = process.env.SEARCH_PROVIDER ?? "tavily";
  if (provider !== "tavily") {
    throw new Error(`Unknown SEARCH_PROVIDER "${provider}". Add it in websearch.ts.`);
  }

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
