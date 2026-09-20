/**
 * `fetch` for upstream DATA sources, with a timeout that cannot be forgotten.
 *
 * Node's fetch has no default timeout, so a bare call waits forever on an
 * upstream that accepts the connection and then says nothing. Before this,
 * `AbortSignal.timeout` appeared in exactly two of fourteen call sites in this
 * repo — so `/api/search`, which awaits the HDB dataset, mall rates, live
 * availability, a geocode and up to ten OneMap routing calls, had no bound on
 * its worst case at all. The droplet agent reported one 9.6s request on
 * 2026-09-20; that one is explained by a cold cache paying for all of them, but
 * the tail underneath it was unbounded rather than slow.
 *
 * A wrapper rather than a constant each caller passes, deliberately. The same
 * month produced `notForCars.ts`, where one rule kept in two places drifted in
 * both directions and each copy looked correct from inside its own file. A
 * timeout every caller must remember to attach is that shape exactly: the
 * failure is silent, and it is invisible in review because the missing thing is
 * absent rather than wrong.
 *
 * A caller passing its own `signal` keeps it — that is how a caller with a
 * genuinely different budget opts out, rather than by dropping back to bare
 * `fetch`.
 *
 * NOT used for the search/LLM providers in `websearch.ts`. Those legitimately
 * take tens of seconds, and giving them a data-source budget would convert
 * working lookups into failures. They still have no timeout, which is a real
 * gap and a separate decision about what the right number is there.
 */

/**
 * 15s, matching `datamall.ts` and `extract.ts`, which were already doing this.
 * A new third number would be a new thing to reconcile for no reason.
 */
export const DATA_FETCH_TIMEOUT_MS = 15_000;

export function dataFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(DATA_FETCH_TIMEOUT_MS),
  });
}
