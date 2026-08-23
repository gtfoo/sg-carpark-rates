/**
 * Keep a model-supplied citation only if the search actually returned it.
 *
 * `sourceUrl` is a free-text field, and a model asked for "the most
 * authoritative URL" will compose one rather than admit it has none. Midview
 * City was stored against `midviewcity.com/midview-city-parking-charges` —
 * domain from the building name, slug from the topic. That host fails its TLS
 * handshake outright and 404s over plain HTTP. Nothing about the string looks
 * wrong until you fetch it.
 *
 * A fabricated citation is worse than an absent one. It tells a verifier the
 * rate was checked against a page, so the row reads as MORE trustworthy than
 * one honestly citing a listing site — while being the row nobody can
 * re-check. Same reasoning as the placeholder URL removed from
 * `anthropicSearch`.
 *
 * Matching is exact-after-normalisation and deliberately NOT same-origin: the
 * Midview URL would have PASSED an origin check, because the homepage was in
 * the results and only the path was invented.
 */
export function citedUrl(claimed: string | null | undefined, hits: string[]): string | null {
  const norm = (u: string) =>
    u
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  if (claimed) {
    const want = norm(claimed);
    const match = hits.find((h) => norm(h) === want);
    if (match) return match;
  }
  return hits[0] ?? null;
}
