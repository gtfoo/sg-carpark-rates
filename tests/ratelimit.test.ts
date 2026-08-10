import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { allow, clientIp, hasAdminSecret, clearRateLimits } from "../src/lib/ratelimit";
import { dewrapName } from "../src/lib/sources/ura";

beforeEach(() => clearRateLimits());

test("the limit holds within a window and resets after it", () => {
  const t0 = 1_000_000;
  assert.equal(allow("k", 2, 1000, t0), true);
  assert.equal(allow("k", 2, 1000, t0 + 10), true);
  assert.equal(allow("k", 2, 1000, t0 + 20), false);
  // The window slides: once the first hit ages out, room opens up.
  assert.equal(allow("k", 2, 1000, t0 + 1005), true);
});

test("keys are independent — one caller can't spend another's budget", () => {
  const t0 = 5_000;
  assert.equal(allow("a", 1, 1000, t0), true);
  assert.equal(allow("a", 1, 1000, t0 + 1), false);
  assert.equal(allow("b", 1, 1000, t0 + 2), true);
});

test("a rejected request does not consume budget", () => {
  // Six attempts against a limit of five: the sixth is refused, and the
  // refusal itself must not push the window forward forever.
  const t0 = 9_000;
  for (let i = 0; i < 5; i++) assert.equal(allow("k", 5, 1000, t0 + i), true);
  assert.equal(allow("k", 5, 1000, t0 + 10), false);
  // All five real hits age out together; the failed sixth left no trace.
  assert.equal(allow("k", 5, 1000, t0 + 1006), true);
});

test("clientIp takes the first forwarded hop and tolerates absence", () => {
  const req = (v?: string) =>
    new Request("http://x/", { headers: v ? { "x-forwarded-for": v } : {} });
  assert.equal(clientIp(req("203.0.113.9, 10.0.0.1")), "203.0.113.9");
  assert.equal(clientIp(req()), "unknown");
});

test("no configured secret admits nobody, not everybody", () => {
  const prev = process.env.CARPARK_ADMIN_SECRET;
  delete process.env.CARPARK_ADMIN_SECRET;
  try {
    const req = new Request("http://x/", { headers: { "x-admin-secret": "anything" } });
    assert.equal(hasAdminSecret(req), "unconfigured");
  } finally {
    if (prev !== undefined) process.env.CARPARK_ADMIN_SECRET = prev;
  }
});

test("the secret must match exactly", () => {
  const prev = process.env.CARPARK_ADMIN_SECRET;
  process.env.CARPARK_ADMIN_SECRET = "s3cret-value";
  try {
    const req = (v?: string) =>
      new Request("http://x/", { headers: v ? { "x-admin-secret": v } : {} });
    assert.equal(hasAdminSecret(req("s3cret-value")), "ok");
    assert.equal(hasAdminSecret(req("s3cret-valuX")), "denied");
    assert.equal(hasAdminSecret(req("s3cret")), "denied");
    assert.equal(hasAdminSecret(req()), "denied");
  } finally {
    if (prev !== undefined) process.env.CARPARK_ADMIN_SECRET = prev;
    else delete process.env.CARPARK_ADMIN_SECRET;
  }
});

test("URA's line-wrap is undone in all three shapes", () => {
  // Mid-word split, word-gap double space, and the sandwiched single letter.
  assert.equal(dewrapName("ADAM RD FOOD CENTRE OF F ST"), "ADAM RD FOOD CENTRE OFF ST");
  assert.equal(dewrapName("ARAB ST - QUEEN ST OFF  ST"), "ARAB ST - QUEEN ST OFF ST");
  assert.equal(
    dewrapName("SERVICE RD (HAMILTON R D - CAVAN RD)"),
    "SERVICE RD (HAMILTON RD - CAVAN RD)",
  );
  assert.equal(
    dewrapName("CHANGI RD (JLN KEMBANG AN - STILL RD)"),
    "CHANGI RD (JLN KEMBANGAN - STILL RD)",
  );
  // A genuinely lettered car park arrives wrapped too, and comes out right.
  assert.equal(dewrapName("FORT CANNING PARK A OF F ST"), "FORT CANNING PARK A OFF ST");
  // Short names never wrapped and are untouched. NOTE: the function is not
  // idempotent — it must only ever run on raw feed names, which is the only
  // place fetchUraCarparks applies it.
  assert.equal(dewrapName("AMOY ST"), "AMOY ST");
  assert.equal(dewrapName("MACKENZIE RD A OFF ST"), "MACKENZIE RD A OFF ST");
});
