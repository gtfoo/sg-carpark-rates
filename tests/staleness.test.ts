import { test } from "node:test";
import assert from "node:assert/strict";
import { assess } from "../scripts/rateStaleness";
import { lastUpdatedFrom } from "../scripts/importLta";

const TODAY = new Date("2026-08-09");

function row(over: Partial<Parameters<typeof assess>[0][number]> = {}) {
  return {
    id: 1,
    display_name: "Somewhere",
    match_value: "SOMEWHERE",
    source: "operator-site",
    source_url: "https://example.com/rates",
    verified_at: "2026-08-01",
    lat: null,
    ...over,
  };
}

test("a rate's age is measured from its source, not from the import", () => {
  // The bug this exists to catch: OneMotoring rows stamped with the scrape
  // date looked a fortnight old when their page was three months stale.
  const rows = [
    row({ source_url: "https://onemotoring.lta.gov.sg/p.html", verified_at: "2026-04-16" }),
    row({ source_url: "https://eservice.ura.gov.sg/x", verified_at: "2026-07-25" }),
  ];
  const s = assess(rows, TODAY);
  const lta = s.byKind.find((k) => k.kind === "LTA OneMotoring")!;
  const ura = s.byKind.find((k) => k.kind === "URA (official)")!;
  assert.equal(lta.oldest, 115);
  assert.equal(ura.oldest, 15);
});

test("the queue is what's past its shelf life, oldest first", () => {
  // AI-retrieved rates get 90 days; an operator page gets a year.
  const rows = [
    row({ id: 1, source: "web-llm", verified_at: "2026-01-01" }), // 220d, over 90
    row({ id: 2, source: "web-llm", verified_at: "2026-07-01" }), // 39d, fine
    row({ id: 3, verified_at: "2026-07-01" }), // operator, 39d, fine
    row({ id: 4, verified_at: "2024-01-01" }), // operator, way over 365
  ];
  const s = assess(rows, TODAY);
  assert.deepEqual(s.overdue.map((o) => o.row.id), [4, 1]);
  assert.ok(s.overdue[0]!.age > s.overdue[1]!.age);
});

test("an undated rate is counted, never treated as fresh", () => {
  const s = assess([row({ verified_at: null })], TODAY);
  assert.equal(s.byKind[0]!.undated, 1);
  assert.equal(s.byKind[0]!.median, null);
  // No date means no age, so it can't be ranked — but it must not silently
  // count as up to date either.
  assert.equal(s.overdue.length, 0);
});

test("a rate with no source URL is flagged as unverifiable", () => {
  // Nowhere to go and re-check, so it can never leave the queue.
  const s = assess([row({ source_url: null }), row({ source: "manual", source_url: null })], TODAY);
  assert.equal(s.unverifiable.length, 1);
});

test("OneMotoring's own last-updated line is read off the page", () => {
  assert.equal(
    lastUpdatedFrom('<div class="footer"><p>Last updated 16 April 2026</p></div>'),
    "2026-04-16",
  );
  assert.equal(lastUpdatedFrom("Last Updated: 3 December 2025"), "2025-12-03");
  // Tags between the words must not defeat it.
  assert.equal(lastUpdatedFrom("<span>Last updated</span> <b>1 May 2026</b>"), "2026-05-01");
  // Rather than guess, an unreadable footer yields nothing.
  assert.equal(lastUpdatedFrom("Updated recently"), null);
  assert.equal(lastUpdatedFrom("Last updated 16 Smarch 2026"), null);
});
