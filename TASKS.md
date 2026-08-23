# Tasks — carpark-sg

What this app owes. **Written only by the carpark agent**; readable by anyone.
Tasks may be suggested by the owner, by this agent, or by another agent — they
arrive as mail and get recorded here. Never imported: this file churns.

Every task carries a `from:` pointer, because the reasoning usually lives in a
letter and a one-line task strands the *why*.

## Open

- [ ] **Phase 2: decide what happens to the on-box script toolchain**
      Carpark runs 17 maintenance scripts by hand on the droplet; that is how
      the rate corpus is imported and refreshed, not a developer convenience. A
      standalone artifact carries neither `scripts/` (untraced — nothing the
      server imports references it) nor `tsx` (a devDependency), so
      `rsync --delete` would leave a running site that cannot update its data.
      Three options offered: ship `scripts/` + a runnable `tsx` in the artifact,
      keep a plain checkout alongside `releases/` as a toolbox, or move imports
      off the box entirely. Not carpark's call alone.
      `from: carpark → droplet · ~/Git/MAIL.md#phase-2-carparks-answers · blocks phase 2`

- [ ] **Phase 2: `data/` and `.env.local` are still inside the tree**
      The droplet agent owns relocating them and setting the unit variables.
      Until that lands carpark cannot migrate at all, since `rsync --delete`
      destroys both. The database is 2.4 MB — smaller than the discussion
      suggests.
      `from: droplet · INFRA.md#current-phase · blocks phase 2`

- [ ] **Relocate the ABI guard when the build moves off the box**
      It currently runs on the droplet before the build; if CI builds the
      artifact, that position stops existing. It must run after the copy and
      before the symlink flip, and must still **construct** a `Database` —
      `require()` alone exits 0 on a genuine mismatch, which is the entire
      reason the guard reads as it does.
      `from: carpark → droplet · ~/Git/MAIL.md#phase-2-carparks-answers · gated on phase 2`

- [ ] **Rates: the EPS coverage gap — 86 queued at ≥200 lots**
      Run `npx tsx scripts/bulkEpsLookup.ts --limit N` on the droplet.
      `--dry-run` first: it costs nothing and prints the exact targets.

      Measured 2026-08-16, so nobody re-derives it: 3,167 EPS entries, 1,401
      already suppressed because a rated carpark (usually HDB) sits within
      40 m, 1,766 genuinely unpriced, and **235** of those have a real name and
      known lots. 235 is the size of this job — not the 3,160 a naive query
      reports, which is an artifact of comparing raw names against the
      normalised `match_value` keys the store actually uses.

      First batch: 5 found of 6. The refusal was correct — the search returned
      only partial hours and `lookupCarparkRate` declines below full
      confidence. Every saved rate is marked "AI-retrieved — verify" and none
      has had a human check yet; that verification is the real backlog sitting
      behind this number.
      `from: carpark agent · own backlog · scripts/bulkEpsLookup.ts`

- [ ] **Rates: a cap that lives in `notes` is never applied**
      Singapore Botanic Gardens (#3408) stores `"07:00-22:30: $0.02 per min"`
      with `"19:00-22:30 capped at max $2.00"` in the notes. `parseLimits`
      reads caps out of the BAND TEXT, so a cap stated only in notes is
      invisible to the fee engine: an 8pm arrival for two hours quotes $2.40
      against a stated $2.00 maximum. Small in dollars, but it is an
      overcharge, and the note makes it look handled.

      Either the extraction should fold a cap into the rate string, or
      `estimateMallFee` should be given the notes. The first is cheaper and
      keeps one parser; the second is harder to get wrong later.
      `from: owner report (blog source) · 2026-08-23 · #3408`

- [ ] **Rates: two rows whose text is not a price**
      `#705` Singapore General Hospital (Carpark G) reads `"7.00am-5.59pm: No
      Entry (Staff Parking Only)"`, and `#860` The Arts House reads
      `"Available at current Parliament House, The Adelphi and the road side
      along Empress Place"`. Both now surface as "not computable" — honest, but
      the first is really an OPENING-HOURS fact and belongs with the
      commercial-hours task below rather than being shown as a broken rate.

      `#3268` and `#3269` Defu Industrial Estate (Lanes 11 and 12) are the same
      shape: `"10.30pm-7.00am: Reserved Parking only"`. Found by the 149 audit,
      and the only survivors of it.

      They only became visible because the name matcher stopped shadowing them
      with a different carpark's row, which had been quietly supplying a
      plausible price for the wrong place.
      `from: carpark agent · matcher fix fallout · 2026-08-23`

- [x] **Rates: the 149 changed name matches are verified — done 2026-08-23**
      Priced every row now targeted by a changed match across four arrival
      hours and five durations. **No mispricings.** 148 of the 149 targets are
      `operator-site` rows, which is the point: the matcher bug affected READS,
      and `upsertOverride` keys on the destination, so no rate was ever
      corrupted by it.

      The first pass reported 72 anomalies and was wrong about 68 of them — it
      counted a flat "per entry" charge costing the same for 30 minutes and
      eight hours as a cap binding too early, which is exactly what a flat rate
      should do. The same shape of error as the citation audit that flagged 330
      dead links and was wrong about 328: a check that fires on correct data is
      worse than no check.

      The 4 that survived are Defu Lane 11 and 12, both `"10.30pm-7.00am:
      Reserved Parking only"` — an access restriction, not a price. Folded into
      the non-price-rows task below rather than treated as a rate defect.
      `from: owner report (MOE Evans Road) · 2026-08-23 · efd2456`

- [ ] **Rates: two mispricings found by `npm run rates-audit`, both overcharges**
      Both under the $50 implausibility threshold, so nothing flagged them.

      **RWS weekend evenings quote $28 where the operator charges $8.**
      `"$8 per entry (Max: $28 per 24 hrs)"` parses as per-block $28/24hr: the
      per-block pattern takes `$28 per 24 hrs` out of the *max* clause and
      treats it as the rate. The Mon-Thu string `"$6 per entry"` is correct, so
      it is the trailing parenthetical that breaks it. Same entry, second
      error: the weekend daytime band loses its cap (8h prices $36 against a
      stated $28 max). Fix candidate: strip the max parenthetical before
      `parseRate`, since `parseLimits` already reads it — do NOT reorder
      flat-per-entry ahead of per-block without the full corpus diff.

      **Jurong Lake Gardens says "not computable" when parking is free.**
      `"$0.60 per 30 mins (8:30am-12pm, 2pm-5am); Free 5am-8:30am & 12pm-2pm"`
      — at 8am and 1pm `bandForTime` returns `"5am-8:30am & 12pm-2pm"` with the
      word "Free" stripped off, so it parses as unparsed. A free band written
      after its hours is not recognised.
      `from: carpark agent · npm run rates-audit · 2026-08-16`

- [ ] **Rates: the corpus gate is six days stale and gates 154 fewer strings**
      `tests/fixtures/rate-corpus.json` is a committed snapshot last exported
      2026-08-10 with 684 strings; production held 838 on 2026-08-16 and 721
      distinct strings on 2026-08-23 (the drop is dedup, not loss). Everything
      imported or retrieved since — including the five AI-retrieved rates from
      2026-08-16 — is gated by nothing. `npm run export-rate-corpus` refreshes
      it, but nothing makes that happen, which is the actual defect.
      `from: carpark agent · npm run rates-audit · 2026-08-16`

- [ ] **Rates: the re-verification queue has no consumer**
      Rows get marked for re-checking and nothing consumes the queue, so a stale
      rate stays stale until a user notices. The marking half already works,
      which makes this look done from the outside.
      `from: carpark agent · own backlog`

- [ ] **JTC rows without coordinates never surface**
      They are in the store but cannot be ranked by distance, so they are
      invisible to search regardless of how good their rates are. Some PDF
      blocks were also skipped by the extractor.
      `from: carpark agent · own backlog`

- [ ] **Commercial opening hours are not modelled**
      Proposal on the table: infer from rate text, treating "no band covers this
      hour" as closed. Deliberately unvalidated — it would wrongly close every
      carpark whose rate text is merely incomplete, which is most of them. Needs
      a way to tell "closed" from "undocumented" before it is worth building.
      `from: owner · discussed in session · unvalidated`

## Declined

- **ERP cost-per-route as a shipped feature.** Two spike scripts
  (`scripts/erpRouteSpike.ts`, `scripts/erpRates.py`) are untracked and stay
  that way. Direction handling and vendored gantry coordinates were never
  finished, and ERP 2.0 replaces the gantry model on 2027-01-01 — building
  against the current scheme buys at most a year and then needs scrapping.
  Parked at the owner's instruction rather than abandoned.
  `from: owner · discussed in session · parked`
