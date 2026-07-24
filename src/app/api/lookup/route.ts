import { lookupCarparkRate } from "@/lib/lookup";
import { isLlmConfigured } from "@/lib/llm";

export const dynamic = "force-dynamic";
// Web search + two LLM calls can take a while; give the request room.
export const maxDuration = 60;

export async function POST(request: Request) {
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

  if (!destination) {
    return Response.json({ error: "destination is required." }, { status: 400 });
  }

  try {
    const result = await lookupCarparkRate({ destination, postal, lat, lng });
    return Response.json(result);
  } catch (err) {
    console.error("lookup failed", err);
    return Response.json(
      { found: false, status: "error", reason: "Web lookup failed. Try again.", sources: [] },
      { status: 200 },
    );
  }
}
