import { lookupCarparkRate } from "@/lib/lookup";
import { isLlmConfigured } from "@/lib/llm";
import { allow, clientIp } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
// Web search + two LLM calls can take a while; give the request room.
export const maxDuration = 60;

export async function POST(request: Request) {
  // Every call here spends a web search and at least one LLM call, and the
  // endpoint is open to anyone who finds it. Checked before anything else so a
  // rejected request costs nothing. Two limits: per-address for fairness, and a
  // global daily ceiling so a spread of addresses still can't drain the keys.
  //
  // The daily ceiling was 40, set when a single free Gemini key and a single
  // Tavily key were the whole budget. Search and extraction now each fall
  // through several providers, so one vendor's cap no longer ends the day, and
  // 40 was stopping the owner testing their own app long before it was
  // protecting anything. Raised to 100 on request.
  if (
    !allow(`lookup:${clientIp(request)}`, 5, 60 * 60 * 1000) ||
    !allow("lookup:all", 100, 24 * 60 * 60 * 1000)
  ) {
    return Response.json(
      {
        found: false,
        status: "error",
        reason: "Lookup limit reached — try again later, or add the rate manually.",
        sources: [],
      },
      { status: 429 },
    );
  }

  if (!isLlmConfigured()) {
    return Response.json(
      { found: false, status: "disabled", reason: "LLM not configured on the server.", sources: [] },
      { status: 200 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const destination = typeof b.destination === "string" ? b.destination.trim() : "";
  const postal =
    typeof b.postal === "string" && b.postal.trim() !== "" ? b.postal.trim() : null;
  const lat = typeof b.lat === "number" ? b.lat : null;
  const lng = typeof b.lng === "number" ? b.lng : null;
  const force = b.force === true;

  if (!destination) {
    return Response.json({ error: "destination is required." }, { status: 400 });
  }

  try {
    const result = await lookupCarparkRate({ destination, postal, lat, lng, force });
    return Response.json(result);
  } catch (err) {
    console.error("lookup failed", err);
    return Response.json(
      { found: false, status: "error", reason: "Web lookup failed. Try again.", sources: [] },
      { status: 200 },
    );
  }
}
