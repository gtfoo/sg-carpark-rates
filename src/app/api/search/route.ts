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

  // "Near me" sends coordinates instead of a place name — there's nothing to
  // geocode, and no destination building whose own rate we'd look up.
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const hasCoords =
    searchParams.has("lat") &&
    searchParams.has("lng") &&
    Number.isFinite(lat) &&
    Number.isFinite(lng);

  if (!destination && !hasCoords) {
    return Response.json({ error: "Missing ?q, or ?lat and ?lng" }, { status: 400 });
  }

  // Every data source here is Singapore-only, so a fix from anywhere else would
  // return the whole country's nearest car parks ranked by hundreds of km. Say
  // so plainly instead.
  const IN_SINGAPORE =
    lat > 1.13 && lat < 1.5 && lng > 103.55 && lng < 104.15;
  if (hasCoords && !IN_SINGAPORE) {
    return Response.json(
      { error: "That location is outside Singapore, which is all this covers." },
      { status: 400 },
    );
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
    const result = await search(
      hasCoords ? { lat, lng } : destination!,
      minutes,
      start,
    );
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
