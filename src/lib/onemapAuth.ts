/**
 * OneMap access tokens expire after ~3 days, so a manually pasted token is a
 * standing breakage: it works today and silently fails on the VPS by the
 * weekend. Preferred setup is to store credentials and let the server mint and
 * refresh tokens on demand.
 *
 * Resolution order:
 *   1. ONEMAP_TOKEN            — a token you pasted yourself (expires!)
 *   2. ONEMAP_EMAIL + PASSWORD — auto-fetched and refreshed (recommended)
 *   3. nothing                 — routing is skipped, distances stay straight-line
 *
 * Credentials are read from the environment only. They are never logged, never
 * returned to the client, and never sent anywhere except OneMap itself.
 */

const TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken";

/** Refresh this long before actual expiry, to avoid racing the deadline. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // 1 hour

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inFlight: Promise<string | null> | null = null;

export async function getOneMapToken(): Promise<string | null> {
  const manual = process.env.ONEMAP_TOKEN?.trim();
  if (manual) return manual;

  const email = process.env.ONEMAP_EMAIL?.trim();
  const password = process.env.ONEMAP_PASSWORD;
  if (!email || !password) return null;

  if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) {
    return cached.token;
  }

  // Collapse concurrent callers onto a single token request.
  if (inFlight) return inFlight;

  inFlight = fetchToken(email, password).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchToken(
  email: string,
  password: string,
): Promise<string | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      // Deliberately does not echo the response body — it can contain the
      // submitted payload.
      console.error(`OneMap token request failed: HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as {
      access_token?: string;
      expiry_timestamp?: string | number;
    };

    if (!body.access_token) {
      console.error("OneMap token response contained no access_token");
      return null;
    }

    cached = {
      token: body.access_token,
      expiresAt: parseExpiry(body.expiry_timestamp),
    };
    return cached.token;
  } catch (err) {
    console.error("OneMap token request threw", err);
    return null;
  }
}

/** OneMap returns a unix timestamp in seconds, as a string. */
function parseExpiry(raw: string | number | undefined): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  // Conservative fallback if the field is missing or unparseable.
  return Date.now() + 24 * 60 * 60 * 1000;
}

/** Test helper — forces the next call to re-fetch. */
export function clearOneMapTokenCache(): void {
  cached = null;
}
