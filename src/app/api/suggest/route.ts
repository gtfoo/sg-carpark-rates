import { suggest } from "@/lib/onemap";

/**
 * Server-side proxy for OneMap address search.
 *
 * The browser must never call OneMap directly: the endpoint now requires an
 * access token, and shipping that token to the client would expose the
 * credential behind it. This route keeps the token on the server and returns
 * only the fields the UI needs.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() ?? "";

  // Autocomplete fires per keystroke; short prefixes match half of Singapore
  // and are not worth an upstream call.
  if (q.length < 2) return Response.json({ suggestions: [] });

  try {
    const suggestions = await suggest(q, 6);
    return Response.json(
      { suggestions },
      {
        // Identical prefixes recur constantly while typing and backspacing.
        headers: { "Cache-Control": "private, max-age=60" },
      },
    );
  } catch (err) {
    console.error("suggest failed", err);
    // Autocomplete is an enhancement — degrade quietly rather than showing
    // the user an error for something they did not explicitly ask for.
    return Response.json({ suggestions: [] });
  }
}
