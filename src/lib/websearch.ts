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
  // Anthropic's own server-side web search, as a last resort that depends on
  // no dedicated search vendor at all — see anthropicSearch below.
  anthropic: "ANTHROPIC_API_KEY",
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
        case "anthropic":
          return await anthropicSearch(query, maxResults);
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

/**
 * Anthropic's own server-side web search, as the last link in the chain.
 *
 * Unlike Tavily and Brave this is not a search API that hands back documents —
 * Claude searches, reads the pages server-side, and answers. Two facts from the
 * API shape decided how it is used here:
 *
 *  - Each `web_search_result` carries `encrypted_content`, decryptable only by
 *    the API on later turns. **The client cannot read the page text**, so there
 *    is nothing to put in `SearchHit.content` from the results themselves.
 *  - Structured outputs are rejected alongside citations (400), and web-search
 *    citations are always on — so this call cannot return the rate schema
 *    directly either.
 *
 * So it is asked to QUOTE the rate text, and its answer plus the citations it
 * grounds become the hits. The existing extraction chain then runs unchanged,
 * which keeps one extractor and one set of parser tests rather than a second
 * private path that could drift.
 *
 * Its real value is dependency shape: this link needs no search vendor at all,
 * so it survives Tavily and Brave being exhausted on the same day.
 *
 * Basic `web_search_20250305` on purpose — the dynamic-filtering versions need
 * a 4.6-or-later model and default to running inside code execution, which is
 * machinery this call has no use for.
 */
async function anthropicSearch(query: string, maxResults: number): Promise<SearchHit[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  const model = process.env.SEARCH_ANTHROPIC_MODEL ?? "claude-haiku-4-5";

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content:
              `Find the published public car parking rates for "${query}" in Singapore. ` +
              `Quote the rate text VERBATIM from the operator's own page where you can, ` +
              `including any weekday/Saturday/Sunday split, per-entry charges, caps and ` +
              `grace periods. Do not convert or summarise the numbers. If you cannot find ` +
              `rates, say so plainly rather than guessing.`,
          },
        ],
        // Search AND fetch. Search alone returns result listings, so the model
        // reasons from snippets and reports "rates not shown in previews" for
        // carparks whose rates are plainly on their own page. web_fetch opens
        // those pages — it can only fetch URLs already in the conversation,
        // which is precisely what the preceding search puts there.
        //
        // Basic variants on both: the dynamic-filtering versions need a 4.6-or
        // -later model, and this runs on Haiku for cost.
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 3 },
          { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
        ],
      }),
    });
  } catch (err) {
    await recordUsage({
      provider: "anthropic",
      model,
      op: "web-search",
      requests: 1,
      units: 0,
      usd: null,
      status: "error",
    });
    throw err;
  }

  const body = (await res.json().catch(() => ({}))) as {
    content?: unknown[];
    usage?: { server_tool_use?: { web_search_requests?: number } };
    error?: { message?: string };
  };
  const searches = body.usage?.server_tool_use?.web_search_requests ?? 0;

  await recordUsage({
    provider: "anthropic",
    model,
    op: "web-search",
    requests: 1,
    // Billed per search performed, not per request. An errored search is free.
    units: res.ok ? searches : 0,
    usd: null,
    status: res.ok ? "ok" : res.status === 429 ? "rate_limited" : "error",
  });

  if (!res.ok) {
    throw new Error(
      `Anthropic web search failed: HTTP ${res.status} ${(body.error?.message ?? "").slice(0, 200)}`,
    );
  }

  const blocks = Array.isArray(body.content) ? body.content : [];
  const answer: string[] = [];
  const cited = new Map<string, { title: string; parts: string[] }>();

  for (const raw of blocks) {
    const b = raw as {
      type?: string;
      text?: string;
      content?: unknown;
      citations?: { url?: string; title?: string; cited_text?: string }[];
    };

    if (b.type === "text" && b.text) {
      answer.push(b.text);
      for (const c of b.citations ?? []) {
        if (!c.url) continue;
        const entry = cited.get(c.url) ?? { title: c.title ?? "", parts: [] };
        if (c.cited_text) entry.parts.push(c.cited_text);
        cited.set(c.url, entry);
      }
    }

    // On an error the tool result's `content` is a single object, not a list —
    // branching on that before iterating is required, not defensive.
    if (b.type === "web_search_tool_result" && !Array.isArray(b.content)) {
      const e = b.content as { error_code?: string } | undefined;
      throw new Error(`Anthropic web search error: ${e?.error_code ?? "unknown"}`);
    }
  }

  const text = answer.join("\n").trim();
  const hits: SearchHit[] = [];

  // Empty, never a placeholder, when nothing was cited. An earlier version put
  // "https://api.anthropic.com/web_search" here and it was stored as a rate's
  // source_url — a citation that looks real, resolves to nothing, and tells a
  // verifier the rate was checked against a page that was never read. No source
  // is honest; a fabricated one is not.
  const primary = [...cited.keys()][0] ?? "";

  // The synthesis first: it holds the quoted rate text the extractor needs.
  //
  // A much larger cap than the other providers use, deliberately. Theirs bounds
  // RAW PAGE DUMPS, where 2,500 characters is generous. This is already the
  // model's condensed answer, so the same cap truncated it mid-table and the
  // extractor refused with "search results are truncated" on a carpark whose
  // rates were right there — paying for a search and discarding the answer.
  if (text) {
    hits.push({
      title: `Web search summary for ${query}`,
      url: primary,
      content: text.slice(0, 8000),
    });
  }

  // Then the grounding quotes, so the extractor can prefer a real source.
  // Skipping `primary` avoids listing one page twice: it is already the
  // synthesis hit's URL, and a duplicated source reads as corroboration the
  // extractor does not actually have.
  for (const [url, { title, parts }] of cited) {
    if (hits.length >= maxResults) break;
    if (url === primary) continue;
    hits.push({ title, url, content: parts.join(" … ").slice(0, 2500) });
  }

  return hits;
}
