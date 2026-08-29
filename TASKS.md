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

- [x] **Rates: the duplicate RWS rows are resolved - done 2026-08-23**
      `#695` was an LTA open-dataset snapshot with `verified_at 2024-06-06`;
      `#1552` cites the operator's own page and was verified 2026-08-10. All
      five of `#1552`'s figures - 9.70, 6.50, 1.10, 16.30, 13.10 - appear
      verbatim on rwsentosa.com, which states "SGD9.70 for 1st hour, SGD1.10
      for half hour or part thereof, Capped at SGD16.30 per day". So `#695` was
      two years stale and is deleted (backed up to `/home/deploy/backups/`).

      Worth recording what the check found, because it was not what the task
      assumed: the NAME path returned `#695` while the SPATIAL path returned
      `#1552`. Two lookup routes were serving different prices for one car park,
      and which one a user saw depended on how they arrived. The name path now
      returns nothing and the spatial path serves `#1552`, priced $9.70 / $11.90
      / $16.30 for 1h / 2h / 8h on a Saturday.
      `from: carpark agent · 2026-08-23`

- [x] **Rates: bracketed band hours now separate - done 2026-08-23**
      Twenty strings, not the three the task estimated. Every rate shaped
      "<rate> (<hours>); <rate> (<hours>)" was unable to reach its second band,
      so one wrong band was applied around the clock: Four Points by Sheraton
      charged $33.60 for an eight-hour evening stay against a $8.50 flat entry
      fee, while Apex @ Henderson charged 80 cents for an evening half hour
      costing $2.50. Same defect, opposite signs.

      Fixed with a SEPARATE boundary rather than by relaxing the bracket
      refusal, which Jurong Lake Gardens depends on. It runs only when the
      primary rule found no cut, and every semicolon clause must carry both a
      price and a clock range - which is what leaves a single band written in
      tiers alone.

      163 of 14,600 cells moved across 20 strings; none lost a price. 16 rose
      and 18 fell, the signature of the right band being chosen rather than
      prices moving.
      `from: carpark agent · 8dc2f57`

- [x] **Rates: a row that is not a price now says why - done 2026-08-23**
      SGH Carpark G ("No Entry (Staff Parking Only)"), The Arts House
      ("Available at current Parliament House..."), Defu Lanes 11 and 12
      ("Reserved Parking only") all rendered "not computable", which reads as a
      parser failure - it invites distrust of the whole row and discards the
      specific thing the operator said.

      `describeNonRate` separates "we could not read this" from "there is no
      parking here". Anything quoting money still returns null however many
      restriction words surround it, because a string with a dollar sign that we
      failed to price IS a defect and must not be explained away. That guard is
      what makes showing the rest safe.

      The HDB path has had this since `shortTermParking=NO`; overrides never
      did, carrying prose instead of a flag.
      `from: carpark agent · b2dc849`

- [ ] **Rates: a web lookup can still duplicate an official dataset**
      Mackenzie Road had two `web-llm` rows sitting ~90 m from three URA rows
      that already covered the street properly — with the free periods and the
      $5 night cap the web versions both omitted. One of them carried
      `"$5.00 per 510 mins"`, which is not a rate at all.

      Today's write-time guard will NOT catch this. It fires at 25 m, and that
      tightness is deliberate: a 60 m radius reported eight false conflicts
      along Orchard Road, where 313@Somerset and Pan Pacific Suites are
      genuinely different car parks. Distance alone cannot separate the two
      cases.

      The check that would: before saving a `web-llm` rate, look for an
      `operator-site` row nearby and refuse — or at least flag — when official
      data already covers the place. Precedence, not proximity. Worth doing
      because the AI path spent a search and an extraction to produce a WORSE
      copy of data already held.
      `from: carpark agent · Mackenzie Road · 2026-08-28`

- [ ] **Search: places OneMap will not find under the name people type**
      `ABC BRICKWORKS MARKET & FOOD CENTRE` is fixed — OneMap could not find its
      own indexed name because of the ampersand, and the retry handles that.
      Two neighbours still fail for a different reason: OneMap calls Tekka
      `TEKKA MARKET` / `ZHUJIAO CENTRE (TEKKA MARKET)`, and has no
      `Waterfront Plaza` entry at all, though we store a rate under that name.

      Progressive word-dropping ("FOOD CENTRE", "CENTRE") would fix Tekka and is
      deliberately NOT the answer: that is the fuzzy truncation that matched
      "THE MILL" to "THE RITZ-CARLTON, MILLENIA SINGAPORE" and let a row keyed
      "MOE" answer for the whole island.

      The safe version is a curated search-alias file — the same shape as
      `eps-aliases-manual.json`, mapping what a person types to what OneMap
      indexes, one entry at a time with a reason. Unknown how many places need
      it; the two known are a start, and our own stored names are the place to
      look for more.
      `from: owner report · 2026-08-28`

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
