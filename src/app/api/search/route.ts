import { search } from "@/lib/search";
import { parseSgtLocal } from "@/lib/time";

/**
 * Availability changes every minute, so this must never be cached.
 * Route Handlers are uncached by default in Next 16 — this is belt and braces.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const destination = searchParams.get("q")?.trim();
  const minutes = Number(searchParams.get("minutes") ?? 120);

  if (!destination) {
    return Response.json({ error: "Missing ?q" }, { status: 400 });
  }
  // Up to 14 days: multi-day stays are normal near the airport, and the fee
  // engine caps each day and night window independently.
  const MAX_MINUTES = 60 * 24 * 14;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
    return Response.json({ error: "Invalid duration" }, { status: 400 });
  }

  // "YYYY-MM-DDTHH:mm" is interpreted as Singapore wall-clock time, never the
  // server's zone — the VPS may well be UTC, and every parking rule is defined
  // in SGT. Omitted means "now".
  const startRaw = searchParams.get("start");
  const start = startRaw ? parseSgtLocal(startRaw) : new Date();
  if (!start) {
    return Response.json(
      { error: "Invalid start time. Expected YYYY-MM-DDTHH:mm." },
      { status: 400 },
    );
  }

  try {
    const result = await search(destination, minutes, start);
    if (!result) {
      return Response.json(
        { error: `Could not find "${destination}" in Singapore.` },
        { status: 404 },
      );
    }
    return Response.json(result);
  } catch (err) {
    console.error("search failed", err);
    return Response.json(
      { error: "Upstream data source unavailable. Try again shortly." },
      { status: 502 },
    );
  }
}
