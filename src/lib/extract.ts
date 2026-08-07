import { generateObjectFallback, isLlmConfigured } from "./llm";
import { RateExtraction, classifyError } from "./lookup";

/**
 * AI-assisted rate entry: instead of a web SEARCH (that's lookup.ts), the user
 * hands us the raw material directly — either a page URL we fetch, or text they
 * copied from an operator's site — and we extract structured rates from it.
 *
 * Unlike lookup.ts this does NOT save; it returns the parsed rates so the Add-a-
 * rate form can pre-fill them for the user to review before saving. AI output
 * always gets a human check before it reaches the database.
 */
export interface ExtractResult {
  found: boolean;
  status: "found" | "not-found" | "error" | "disabled";
  reason?: string;
  weekdayRate?: string | null;
  fridayRate?: string | null;
  saturdayRate?: string | null;
  sundayPhRate?: string | null;
  carparkName?: string | null;
  notes?: string | null;
  sourceUrl?: string | null;
}

const UA =
  "Mozilla/5.0 (compatible; carpark-sg/1.0; +https://github.com/gtfoo/carpark-sg)";

/** Strip a page down to readable text for the model. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

/** Reject non-http(s) and obviously-internal hosts (light SSRF guard). */
function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^(10\.|127\.|192\.168\.|169\.254\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }
  return u;
}

export async function extractRate(args: {
  source: "url" | "text";
  value: string;
}): Promise<ExtractResult> {
  if (!isLlmConfigured()) {
    return {
      found: false,
      status: "disabled",
      reason: "AI extraction isn't configured on the server (no LLM key).",
    };
  }

  let text = args.value.trim();
  let sourceUrl: string | null = null;

  if (args.source === "url") {
    const u = safeUrl(args.value);
    if (!u) {
      return { found: false, status: "error", reason: "That isn't a valid public URL." };
    }
    sourceUrl = u.toString();
    try {
      const res = await fetch(sourceUrl, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return {
          found: false,
          status: "error",
          reason: `Couldn't fetch that page (HTTP ${res.status}). Try copy-pasting the rates instead.`,
        };
      }
      text = htmlToText(await res.text());
    } catch (err) {
      return {
        found: false,
        status: "error",
        reason: `Couldn't reach that page (${
          err instanceof Error ? err.message : "network error"
        }). Try copy-pasting the rates instead.`,
      };
    }
    if (text.length < 40) {
      return {
        found: false,
        status: "not-found",
        reason:
          "That page had almost no readable text — it's likely a JavaScript app. Copy-paste the rates instead.",
      };
    }
  }

  if (!text) {
    return { found: false, status: "error", reason: "Nothing to read." };
  }

  try {
    const { object } = await generateObjectFallback({
      schema: RateExtraction,
      prompt:
        `Extract the CURRENT public car park parking rates for CARS from the ` +
        `${args.source === "url" ? "web page text" : "text a user copied from a car park operator's site"} ` +
        `below. Ignore motorcycle and lorry/heavy-vehicle rates. Only set ` +
        `found=true if it genuinely contains car parking rates.\n\n` +
        `Each day's rate MUST be ONE short machine-parseable expression, exactly ` +
        `one of these shapes:\n` +
        `  "$X per 30 mins"  |  "$X per hour"  |  "$X for 1st hr; $Y per sub 30 ` +
        `mins"  |  "$X per entry"  |  "Free"\n` +
        `Rules: use the MAIN daytime rate. Keep the word "sub" for the ` +
        `subsequent-block price. Do NOT put time ranges like "(0000-1759)", ` +
        `caps, or grace periods in the rate string — those go in notes. If one ` +
        `schedule covers all days, put it in weekdayRate and leave the others ` +
        `null.\n` +
        `Several malls bill FRIDAY with the weekend ("Fri-Sun & PH"). When the ` +
        `page does that, put the Friday figure in fridayRate; leave it null if ` +
        `Friday is grouped with Mon-Thu.\n\n` +
        `Content:\n${text}`,
    });

    if (!object.found || !object.weekdayRate) {
      return {
        found: false,
        status: "not-found",
        reason: object.notes ?? "No parking rates found in that content.",
      };
    }

    return {
      found: true,
      status: "found",
      weekdayRate: object.weekdayRate,
      fridayRate: object.fridayRate,
      saturdayRate: object.saturdayRate,
      sundayPhRate: object.sundayPhRate,
      carparkName: object.carparkName,
      notes: object.notes,
      // Prefer the URL the user gave us; fall back to one the model spotted.
      sourceUrl: sourceUrl ?? object.sourceUrl ?? null,
    };
  } catch (err) {
    console.error("extract provider error", err);
    return { found: false, status: "error", reason: classifyError(err) };
  }
}
