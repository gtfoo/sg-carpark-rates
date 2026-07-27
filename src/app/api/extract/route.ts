import { extractRate } from "@/lib/extract";
import { isLlmConfigured } from "@/lib/llm";

export const dynamic = "force-dynamic";
// Fetching a page + one LLM call; give it room.
export const maxDuration = 45;

export async function POST(request: Request) {
  if (!isLlmConfigured()) {
    return Response.json(
      { found: false, status: "disabled", reason: "AI extraction isn't configured on the server." },
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
  const source = b.source === "url" ? "url" : b.source === "text" ? "text" : null;
  const value = typeof b.value === "string" ? b.value.trim() : "";

  if (!source) {
    return Response.json({ error: "source must be 'url' or 'text'." }, { status: 400 });
  }
  if (!value) {
    return Response.json({ error: "value is required." }, { status: 400 });
  }
  if (source === "text" && value.length > 20000) {
    return Response.json({ error: "Pasted text is too long." }, { status: 400 });
  }

  try {
    const result = await extractRate({ source, value });
    return Response.json(result);
  } catch (err) {
    console.error("extract failed", err);
    return Response.json(
      { found: false, status: "error", reason: "Extraction failed. Try again." },
      { status: 200 },
    );
  }
}
