import {
  listOverrides,
  upsertOverride,
  deleteOverride,
  type MatchType,
  type RateSource,
} from "@/lib/store/rates";
import { resolveGapsByName } from "@/lib/store/gaps";

export const dynamic = "force-dynamic";

const MATCH_TYPES: MatchType[] = ["carpark_no", "postal", "name"];
const SOURCES: RateSource[] = ["manual", "operator-site", "web-llm"];

export async function GET() {
  return Response.json({ overrides: listOverrides() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const matchType = b.matchType;
  const matchValue = b.matchValue;

  if (typeof matchValue !== "string" || matchValue.trim() === "") {
    return Response.json({ error: "matchValue is required." }, { status: 400 });
  }
  if (typeof matchType !== "string" || !MATCH_TYPES.includes(matchType as MatchType)) {
    return Response.json(
      { error: `matchType must be one of ${MATCH_TYPES.join(", ")}.` },
      { status: 400 },
    );
  }
  const source = typeof b.source === "string" ? b.source : "manual";
  if (!SOURCES.includes(source as RateSource)) {
    return Response.json(
      { error: `source must be one of ${SOURCES.join(", ")}.` },
      { status: 400 },
    );
  }

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const override = upsertOverride({
    matchType: matchType as MatchType,
    matchValue,
    displayName: str(b.displayName),
    weekdayRate: str(b.weekdayRate),
    saturdayRate: str(b.saturdayRate),
    sundayPhRate: str(b.sundayPhRate),
    source: source as RateSource,
    sourceUrl: str(b.sourceUrl),
    // Default to today (SGT-agnostic ISO date is fine for a "verified on" stamp).
    verifiedAt: str(b.verifiedAt) ?? new Date().toISOString().slice(0, 10),
    notes: str(b.notes),
    lat: typeof b.lat === "number" ? b.lat : null,
    lng: typeof b.lng === "number" ? b.lng : null,
  });

  // Clear any gap this rate now covers.
  const resolved = resolveGapsByName(override.displayName ?? override.matchValue);

  return Response.json({ override, gapsResolved: resolved });
}

export async function DELETE(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "Valid ?id required." }, { status: 400 });
  }
  return Response.json({ deleted: deleteOverride(id) });
}
