import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceTier,
  statesAPrice,
  rankCitations,
  allBlocked,
  hostOf,
} from "../src/lib/sourceQuality";

/**
 * Two properties, deliberately kept apart:
 *
 *   EVIDENCE  does the page state the rate?
 *   TRUST     is the publisher accountable?
 *
 * MOE (Evans Road) proved trust alone is worthless. It was re-cited from a
 * free-hosting carpark directory to streetdirectory.com — the better-known
 * host — whose page contains no dollar amount in 86 KB of HTML, while the page
 * it replaced states "$1.20", "Parking Rates" and "Grace period".
 *
 * Singapore Botanic Gardens proved evidence alone is worthless too: a personal
 * WordPress post quoting a rate that contradicted itself.
 */

const VERCEL = "https://parking-go-where.vercel.app/carpark/moe-evans-road";
const SD = "https://www.streetdirectory.com/sd_mobile/place/108107_27152";
const BLOG = "https://jimsonfyp.wordpress.com/tourist-spot/singapore-botanic-garden";
const OPERATOR = "https://www.nparks.gov.sg/sbg/visit-us/parking";

test("tiers separate a blog from a side project from an operator", () => {
  assert.equal(sourceTier(BLOG), "blocked");
  assert.equal(sourceTier(VERCEL), "weak");
  assert.equal(sourceTier(SD), "ok");
  assert.equal(sourceTier(OPERATOR), "ok");
  assert.equal(sourceTier("https://a.b.wordpress.com/x"), "blocked");
  // Must not match by substring: an unrelated real domain.
  assert.equal(sourceTier("https://wordpress.com.sg.example.org/x"), "ok");
});

test("a page quoting money is evidence", () => {
  assert.equal(statesAPrice("Parking Rates: $1.20 per hour"), true);
  assert.equal(statesAPrice("$ 2"), true);
  assert.equal(statesAPrice("Find car parks near you. Directions and reviews."), false);
  assert.equal(statesAPrice(null), false);
});

test("the page that states the rate wins over the better-known host", () => {
  // The exact regression: streetdirectory outranked the page with the price.
  const ranked = rankCitations([
    { url: SD, content: "MOE HQ Evans Road. Map, directions, nearby." },
    { url: VERCEL, content: "Parking Rates $1.20 per hour. Grace period 15 min." },
  ]);
  assert.equal(ranked[0], VERCEL);
});

test("among pages that all state the rate, reputation decides", () => {
  const ranked = rankCitations([
    { url: VERCEL, content: "$1.20 per hour" },
    { url: OPERATOR, content: "$1.20 per hour" },
  ]);
  assert.equal(ranked[0], OPERATOR);
});

test("blogs are dropped, not merely ranked last", () => {
  const ranked = rankCitations([
    { url: BLOG, content: "$0.02 per minute" },
    { url: OPERATOR, content: "no prices here" },
  ]);
  assert.deepEqual(ranked, [OPERATOR]);
  assert.equal(ranked.includes(BLOG), false);
});

test("an all-blog result set is refused rather than cited", () => {
  assert.equal(allBlocked([{ url: BLOG }]), true);
  assert.equal(allBlocked([{ url: BLOG }, { url: VERCEL }]), false);
  assert.equal(allBlocked([]), false);
  assert.deepEqual(rankCitations([{ url: BLOG, content: "$5" }]), []);
});

test("junk input is unusable, not untrusted", () => {
  assert.equal(sourceTier(null), "ok");
  assert.equal(hostOf("not a url"), "");
});

test("a peer parking app is a derivative source, not a citation", () => {
  // parkaholic.sg assembles rates from the public web, exactly as this app
  // does, so pointing a citation there is circular: it reads as corroboration
  // and is really our own method reflected back. Weak, not blocked — these are
  // often accurate, and refusing a save when one is all that exists would cost
  // real coverage.
  const peer = "https://parkaholic.sg/M0001";
  assert.equal(sourceTier(peer), "weak");

  // An operator or established directory that states the rate still wins.
  assert.equal(
    rankCitations([
      { url: peer, content: "$1.20 per half hour" },
      { url: "https://www.motorist.sg/carpark/x", content: "$1.20 per half hour" },
    ])[0],
    "https://www.motorist.sg/carpark/x",
  );

  // But it is still cited ahead of a reputable page that quotes no price at
  // all — evidence outranks reputation, as MOE (Evans Road) established.
  assert.equal(
    rankCitations([
      { url: "https://www.streetdirectory.com/x", content: "Map and directions" },
      { url: peer, content: "$1.20 per half hour" },
    ])[0],
    peer,
  );
});
