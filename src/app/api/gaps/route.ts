import { listGaps, resolveGap } from "@/lib/store/gaps";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const includeResolved =
    new URL(request.url).searchParams.get("all") === "true";
  return Response.json({ gaps: listGaps(includeResolved) });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const id = Number((body as Record<string, unknown>).id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "Valid id required." }, { status: 400 });
  }
  return Response.json({ resolved: resolveGap(id) });
}
