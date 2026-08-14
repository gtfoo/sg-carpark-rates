import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The usage log is an interface with another agent's code (gtfoo reads every
 * app's file and renders /admin/usage). These tests pin the parts of that
 * contract we could break without noticing, because the failure would show up
 * as a wrong number on someone else's dashboard rather than as an error here.
 */

import { recordUsage, usageFile, resetUsageState, isRateLimit } from "../src/lib/usage";

// Import order is irrelevant: the module reads USAGE_DIR per call, not at load.
// That is deliberate — see the comment on dir() — and it is what lets these
// tests point emission at a temp directory at all.
const DIR = mkdtempSync(path.join(tmpdir(), "usage-"));
process.env.USAGE_DIR = DIR;
process.env.USAGE_APP = "carpark";

function lines(): Record<string, unknown>[] {
  if (!existsSync(usageFile())) return [];
  return readFileSync(usageFile(), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("a call is one line of JSON, with app and timestamp filled in", async () => {
  await recordUsage({ provider: "google", model: "gemini-flash-latest", op: "rate-lookup", requests: 1 });
  const all = lines();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.app, "carpark");
  assert.equal(all[0]!.provider, "google");
  assert.equal(all[0]!.op, "rate-lookup");
});

test("the timestamp is ISO-8601 UTC, because the reader compares it as a string", async () => {
  // gtfoo does `if (c.ts < cutoff) continue` against an ISO cutoff. An offset
  // stamp like +08:00 sorts wrong and would silently drop or admit rows.
  const ts = lines()[0]!.ts as string;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(ts).toISOString(), ts);
});

test("free-tier calls record usd as null, never 0", async () => {
  await recordUsage({ provider: "google", usd: null, units: null, status: "ok" });
  const last = lines().at(-1)!;
  assert.equal(last.usd, null);
  assert.notEqual(last.usd, 0);
});

test("undefined fields are omitted rather than written as null", async () => {
  // The reader treats a missing field and an explicit null differently for
  // `units`/`usd`; everything else should simply be absent.
  await recordUsage({ provider: "tavily", requests: 1 });
  const last = lines().at(-1)!;
  assert.ok(!("model" in last));
  assert.ok(!("in_tokens" in last));
});

test("every line is a complete JSON object on its own line", async () => {
  await recordUsage({ provider: "google", op: "a" });
  await recordUsage({ provider: "google", op: "b" });
  const raw = readFileSync(usageFile(), "utf8");
  assert.ok(raw.endsWith("\n"), "a partial last line would corrupt the next append");
  for (const l of raw.split("\n").filter(Boolean)) JSON.parse(l);
});

test("a line stays well under the 4096-byte atomic append limit", async () => {
  // Concurrent appends from four apps only stay un-interleaved while a single
  // write fits in the pipe buffer. A long op name is the realistic way to
  // outgrow it, so this is a real guard rather than a formality.
  await recordUsage({ provider: "google", model: "gemini-flash-latest", op: "rate-lookup" });
  const longest = Math.max(...readFileSync(usageFile(), "utf8").split("\n").map((l) => l.length));
  assert.ok(longest < 4096, `longest line was ${longest} bytes`);
});

test("the file is created 0644 so the box-level reader can read it", async () => {
  const mode = statSync(usageFile()).mode & 0o777;
  assert.equal(mode & 0o044, 0o044, `mode was ${mode.toString(8)}`);
});

test("a missing directory disables emission instead of throwing", async () => {
  // The real state of the box today: /var/lib/usage has not been created yet.
  // Emission must degrade to nothing rather than take a user request with it.
  const saved = process.env.USAGE_DIR;
  process.env.USAGE_DIR = path.join(DIR, "does", "not", "exist");
  resetUsageState();
  try {
    await assert.doesNotReject(() => recordUsage({ provider: "google", op: "while-missing" }));
    assert.ok(!existsSync(usageFile()), "must not create the directory itself");
    // And it stays off for the process, so a busy app logs one warning, not one per call.
    await recordUsage({ provider: "google", op: "still-missing" });
  } finally {
    process.env.USAGE_DIR = saved;
    resetUsageState();
  }
  // The original file is untouched by any of that.
  assert.ok(lines().every((l) => l.op !== "while-missing" && l.op !== "still-missing"));
});

test("rate limits are told apart from other errors", () => {
  assert.ok(isRateLimit(new Error("429 Too Many Requests")));
  assert.ok(isRateLimit(new Error("RESOURCE_EXHAUSTED: quota exceeded")));
  assert.ok(isRateLimit("rate limit reached"));
  assert.ok(!isRateLimit(new Error("400 invalid schema")));
  assert.ok(!isRateLimit(new Error("ECONNRESET")));
});

test("status uses only the three values the reader counts", async () => {
  for (const status of ["ok", "rate_limited", "error"] as const) {
    await recordUsage({ provider: "google", status });
  }
  const last3 = lines().slice(-3).map((l) => l.status);
  assert.deepEqual(last3, ["ok", "rate_limited", "error"]);
});
