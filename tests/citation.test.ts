import { test } from "node:test";
import assert from "node:assert/strict";
import { citedUrl } from "../src/lib/citation";

/**
 * A rate's `source_url` is the only thing a human can use to check it. If the
 * model is allowed to invent one, the rate becomes unverifiable while LOOKING
 * better sourced than an honest one.
 *
 * The case that prompted this: Midview City stored against
 * `midviewcity.com/midview-city-parking-charges` — a URL whose host fails its
 * TLS handshake and 404s over plain HTTP. It was never in the search results.
 */

const HITS = [
  "https://www.motorist.sg/carpark/midview-city",
  "https://www.midviewcity.com",
  "https://sgcarmart.com/news/parking",
];

test("a URL the search actually returned is kept", () => {
  assert.equal(
    citedUrl("https://www.motorist.sg/carpark/midview-city", HITS),
    "https://www.motorist.sg/carpark/midview-city",
  );
});

test("cosmetic differences still count as the same citation", () => {
  // The model routinely re-types a URL with a trailing slash, http, or no
  // www. Rejecting those would throw away a GENUINE citation and silently
  // demote the row to hits[0], which is the opposite of the intent.
  for (const claimed of [
    "http://motorist.sg/carpark/midview-city",
    "https://www.motorist.sg/carpark/midview-city/",
    "  https://WWW.Motorist.sg/carpark/Midview-City  ",
  ]) {
    assert.equal(
      citedUrl(claimed, HITS),
      "https://www.motorist.sg/carpark/midview-city",
      `should have matched: ${claimed}`,
    );
  }
});

test("an invented path on a real domain is refused", () => {
  // The regression. `midviewcity.com` IS in the results, so a same-origin
  // check would have passed this — only the path was fabricated. That is
  // exactly why the match is whole-URL and not by host.
  assert.equal(
    citedUrl("https://www.midviewcity.com/midview-city-parking-charges", HITS),
    HITS[0],
  );
});

test("a wholly invented URL is refused", () => {
  assert.equal(citedUrl("https://example.com/rates", HITS), HITS[0]);
});

test("no claim falls back to the first real hit", () => {
  assert.equal(citedUrl(null, HITS), HITS[0]);
  assert.equal(citedUrl(undefined, HITS), HITS[0]);
  assert.equal(citedUrl("", HITS), HITS[0]);
});

test("with no hits at all the answer is null, never a guess", () => {
  // An empty citation is honest. This is the same call as removing the
  // placeholder Anthropic URL from the native-search path.
  assert.equal(citedUrl("https://www.midviewcity.com/parking", []), null);
  assert.equal(citedUrl(null, []), null);
});
