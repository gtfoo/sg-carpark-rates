/**
 * Is this the name of a bay a car may not park in?
 *
 * Two sources feed the result list and each had grown its OWN copy of this
 * test, which is why this module exists rather than a function in either of
 * them. They had drifted apart in both directions:
 *
 *   eps.ts      heavy vehicle, lorry, container, loading, coach stand
 *   search.ts   HVP, heavy vehicle, lorry
 *
 * So an EPS entry named "… HVP" surfaced while a saved rate with the same name
 * did not, and "Golden Mile Tower Loading Bay" was excluded as an EPS entry
 * while an identically-named saved rate would still have been listed. Neither
 * gap was visible from inside either file. It is the same failure the brand
 * palette rules in AGENTS.md describe — two copies of a rule is how half of
 * something ends up correct.
 *
 * What each pattern is for:
 *
 * - **HVP** — URA files heavy vehicle parks this way, e.g. "BENDEMEER RD HVP",
 *   "URA / FOREST HILL HVP". "HV" alone is deliberately NOT matched: two
 *   letters is too short to be safe inside ordinary names.
 * - **heavy vehicle / lorry / container** — other feeds spell it out. No source
 *   flags vehicle type as a field, so the name is the only evidence there is.
 * - **loading** — matched on the bare word rather than on "loading bay",
 *   because EPS spells the same thing three ways: "GOLDEN MILE TOWER LOADING
 *   BAY", "ASCENT_LOADING BAY" (which reaches a card as "ASCENT / LOADING
 *   BAY"), and "THE STAR (LOADING AND UNLOADING BAY)". Nothing else in the
 *   3,167-row inventory carries the word.
 * - **coach stand** — tour coaches at Changi. Four entries.
 *
 * This is a claim about the NAME, which is why it can live in one place and be
 * applied to every source. Rows that are wrong in a way the name cannot settle
 * belong in eps-suppressed.json instead, one id at a time with the evidence.
 */
export function isNotForCars(name: string): boolean {
  return (
    /\bHVP\b/i.test(name) ||
    /heavy[\s-]?vehicle/i.test(name) ||
    /\b(lorry|container)\b/i.test(name) ||
    /\b(un)?loading\b/i.test(name) ||
    /\bcoach stand\b/i.test(name)
  );
}
