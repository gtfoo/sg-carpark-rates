import { test } from "node:test";
import assert from "node:assert/strict";
import { isLowTrustSource, trustworthySources, hostOf } from "../src/lib/sourceQuality";

/**
 * Singapore Botanic Gardens was stored against a personal WordPress post. The
 * URL resolved, the page existed and the location was right, so the citation
 * guard, the reachability audit and the location guard all passed it. What was
 * wrong cannot be detected by fetching: nobody maintains it and it carries no
 * revision date.
 */

test("free publishing platforms are low trust", () => {
  for (const u of [
    "https://jimsonfyp.wordpress.com/tourist-spot/singapore-botanic-garden",
    "https://someone.blogspot.com/2019/parking",
    "https://medium.com/@x/sg-parking",
    "https://foo.wixsite.com/rates",
  ]) {
    assert.equal(isLowTrustSource(u), true, u);
  }
});

test("free app hosting is low trust", () => {
  // A real trade-off, not a free win: this exact host carried a MOE rate that
  // appears to be correct. It survives because other sources had it too.
  assert.equal(isLowTrustSource("https://parking-go-where.vercel.app/carpark/moe-evans-road"), true);
  assert.equal(isLowTrustSource("https://x.netlify.app/a"), true);
  assert.equal(isLowTrustSource("https://y.github.io/parking"), true);
});

test("operators, aggregators and government are not", () => {
  for (const u of [
    "https://www.nparks.gov.sg/sbg/visit-us/parking",
    "https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1",
    "https://www.motorist.sg/carpark/midview-city",
    "https://en.parkopedia.sg/parking/carpark/x/1/singapore",
    "https://parking-go-where.com/carpark/rail-mall",
    "https://www.railmall.com.sg/parking",
  ]) {
    assert.equal(isLowTrustSource(u), false, u);
  }
});

test("a bare domain and its subdomains are both caught", () => {
  assert.equal(isLowTrustSource("https://wordpress.com/x"), true);
  assert.equal(isLowTrustSource("https://a.b.wordpress.com/x"), true);
  // Must not match by mere substring: this is a real, unrelated company.
  assert.equal(isLowTrustSource("https://wordpress.com.sg.example.org/x"), false);
});

test("junk input is not low trust, it is just unusable", () => {
  assert.equal(isLowTrustSource(null), false);
  assert.equal(isLowTrustSource(""), false);
  assert.equal(isLowTrustSource("not a url"), false);
  assert.equal(hostOf("not a url"), "");
});

test("filtering keeps order and can empty the list", () => {
  const hits = [
    "https://jimsonfyp.wordpress.com/a",
    "https://www.nparks.gov.sg/b",
    "https://x.vercel.app/c",
    "https://www.motorist.sg/d",
  ];
  assert.deepEqual(trustworthySources(hits), [
    "https://www.nparks.gov.sg/b",
    "https://www.motorist.sg/d",
  ]);
  // All-blog results must come back empty so the caller refuses the save,
  // rather than quietly citing the first blog anyway.
  assert.deepEqual(trustworthySources(["https://a.wordpress.com/x"]), []);
});
