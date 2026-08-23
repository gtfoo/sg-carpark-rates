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

- [x] **Rates: a cap in `notes` was applied at the WRONG HOURS — done 2026-08-23**
      The task as written was wrong, and worth recording as such: it claimed a
      cap in the notes is never applied. `limitsForOverride` already feeds
      `notesForTime`'s output to `parseLimits`, so it always was — just at every
      hour instead of its own. Reading the code rather than measuring it is how
      the entry came to be wrong.

      Real cause: `CLOCK` accepted "7.00am" and "0700hrs" but not "19:00", so
      `notesForTime` found no range in "19:00-22:30 capped at max $2.00" and a
      clause naming no hours is global by design. Botanic Gardens quoted $2.00
      for eight hours that cost $9.60. Fixed by teaching the clock the 24-hour
      colon form; the dot form stays out, since "7.00" and an amount are
      indistinguishable.
      `from: owner report · 2026-08-23 · 8bef306`

- [ ] **Rates: bands delimited by BRACKETED hours never separate**
      Waterfront Plaza & King's Centre reads `"$3.50 for 1st hr, $2.00 for
      add'l hr (07:00-17:00); $4.00 per entry (17:00-07:00)"` and prices $4.00
      at every hour — the last clause wins — so a daytime stay is undercharged
      ($4.00 against $5.50) and the evening is right only by accident.

      `splitBands` cuts at the START of a clock range and refuses to cut inside
      brackets. That refusal is load-bearing: Jurong Lake Gardens
      (`"$0.60 per 30 mins (8:30am-12pm, 2pm-5am); Free …"`) is structurally
      identical and breaks without it. Here the correct cut is the SEMICOLON,
      which the cut-at-range-starts model cannot express — so this needs the
      splitter to gain a second kind of boundary, not a tweak to the existing
      one.

      Only three corpus strings use bracketed band hours, so the payoff is
      small and the regression surface is the entire band splitter. Do it with
      the full corpus diff, and keep the JLG strings as the guard.
      `from: carpark agent · found while fixing the 24-hour clock · 2026-08-23`

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

- [x] **Rates: the two `rates-audit` mispricings are fixed - done 2026-08-23**
      **RWS quoted $28 for an $8 stay.** "$8 per entry (Max: $28 per 24 hrs)"
      had its ceiling read as a limit AND left in the text, where the per-block
      pattern took "$28 per 24 hrs" for the rate. `parseLimits` matched
      max|cap|capped; `withoutCaps` matched only the literal word "capped". Two
      functions that must agree about what a cap looks like did not, and only
      one of them was ever wrong out loud.

      **RWS weekend daytime lost that cap**, pricing 8h at $36 against the same
      stated $28. A ceiling naming a whole-day period now applies to every
      band. Scoped to caps that NAME the period, because QUEEN ST's
      "(capped at $5.00)" states none and must stay in its own band - that leak
      once quoted $5 for an eight-hour weekday stay.

      **Jurong Lake Gardens said "not computable" while parking was free.**
      Bands cut at the start of a clock range, so "...; Free 5am-8:30am" split
      the word from its hours. Two rules were needed: back the cut over a
      trailing "Free", and keep ranges joined by "&" in one band - "free"
      counts as a price, so it walked straight past the "$ seen since the last
      cut" guard that normally holds a band's ranges together.

      Each change was diffed across all 730 corpus strings x 4 arrival hours x
      5 durations. Nothing lost a price; MAX_UNPRICEABLE fell 10 -> 9.
      `from: carpark agent · 2d6af8d, 5a079e6, 80539c2`

- [x] **Rates: the corpus gate is refreshed - done 2026-08-23**
      684 -> 730 strings. Everything imported or AI-retrieved since 2026-08-10
      was gated by nothing, including the rates added this week, so a
      regression net with holes in it was reading as a passing build.

      Refreshed BEFORE the parser work that followed, so the RWS, Jurong Lake
      Gardens and 24-hour-clock edits were each diffed against the full corpus
      rather than two-thirds of it. MAX_UNPRICEABLE held at 10 on refresh (the
      46 new strings all priced) and then fell to 9.

      **The actual defect is still open**: nothing makes this happen. It was
      six days stale because refreshing is a manual step nobody is prompted to
      take. Worth a check that fails when the fixture is materially smaller
      than the store - `rateAudit --from-db --ci` already runs on the droplet
      at deploy and could compare the counts.
      `from: carpark agent · f0ffd80`

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
