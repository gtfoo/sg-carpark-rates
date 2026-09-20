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

- [ ] **Rates: the EPS coverage gap — 69 queued at ≥200 lots**
      Run `npx tsx scripts/bulkEpsLookup.ts --limit N` on the droplet.
      `--dry-run` first: it costs nothing and prints the exact targets.

      **69** on 2026-09-20, not the 86 this heading carried — the queue shrinks
      as rates arrive, so the number in a heading is a snapshot and the dry run
      is the truth. 6 of the next batch were skipped because the store already
      answers for them. Top of the queue is MTOWER (749 lots), whose rate was
      researched by hand in an earlier session and never applied for want of an
      answer on whether to trust it.

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

- [x] **Rates: a web lookup can still duplicate an official dataset — done 2026-09-20**
      Mackenzie Road had two `web-llm` rows sitting ~90 m from three URA rows
      that already covered the street properly — with the free periods and the
      $5 night cap the web versions both omitted. One of them carried
      `"$5.00 per 510 mins"`, which is not a rate at all.

      Today's write-time guard will NOT catch this. It fires at 25 m, and that
      tightness is deliberate: a 60 m radius reported eight false conflicts
      along Orchard Road, where 313@Somerset and Pan Pacific Suites are
      genuinely different car parks. Distance alone cannot separate the two
      cases.

      **The check proposed here was wrong, and measuring it first is what
      caught that.** `scripts/precedenceSweep.ts` (new, report-only) flags every
      `web-llm` row within 150 m of an `operator-site` row: **47 of 100**. And 46
      of those 47 are CORRECT — *SCAPE, Aperia Mall, Bangkok Bank Building,
      Chinatown Point, Amara Hotel, Kallang Riverside Condominium. Nearly every
      official neighbour is URA STREET parking named after a road, and a mall's
      basement is not the road outside it. "Precedence, not proximity" still
      loses, because the official row is evidence about a different car park.
      Refusing on that rule would have suppressed 46 rows to catch 1.

      The one real hit is `#3459 "N0012"`, 61 m from NORTH BRIDGE RD MARKET OFF
      ST, quoting the same $0.60 per 30 mins WITHOUT the $5.00 cap the official
      row carries — the Mackenzie signature exactly.

      What separates it is the NAME, not the distance. A filing code names a
      facility an official feed files, so a web row wearing one is a second copy
      of an official record; a building name is not, however close the street
      row sits. Shipped as that: `isCodeName` (already used to stop EPS codes
      reaching a card) now also gates the save, with the radius demoted to
      merely requiring that an official row is present. `tests/precedence.test.ts`
      pins 31 of the real building names as MUST-NOT-REFUSE.
      `from: carpark agent · Mackenzie Road · 2026-08-28 · measured 2026-09-20`

- [ ] **Search: OneMap answers some names with the wrong building**
      Mechanism built and three cases fixed (`3c1afbd`,
      `src/lib/onemap-aliases.json`). What remains is that nobody knows how many
      more there are.

      The shape: the search is fuzzy and a different building outranks the one
      named. "Changi General Hospital" returns CGH BUILDING at 131 Killiney
      Road, 13 km away. "The Mill" returns THE RITZ-CARLTON, MILLENIA SINGAPORE,
      because Millenia begins with Mill. Both had already put a STORED RATE in
      the wrong place before anyone noticed. "Tekka Market & Food Centre"
      returns nothing at all, even after the ampersand retry.

      No automatic detector, and that was measured rather than assumed:
      requiring the geocoded name to resemble the query rejects 48 of 140
      sampled rows — "BEATTY RD" answering "BEATTY ROAD", "JLN KLAPA" answering
      "JALAN KLAPA" — every one correct and 0.0-0.3 km away. It would strip
      coordinates from a third of the store.

      Finding the rest needs a sweep somebody reads: geocode every stored
      display name, list the answers sharing nothing with the query, judge them
      one at a time. Expect mostly false alarms.
      `from: owner reports · 2026-08-28`

- [x] **Rates: the rate-gap queue has a consumer — done 2026-08-28**
      `scripts/bulkGapLookup.ts`. The queue had a producer (`recordGap`, on
      every search that finds no price) and two viewers, and nothing that acted
      on it. It works DEMAND, ordered by how often a place was asked for — the
      complement to `bulkEpsLookup` working INVENTORY ordered by lots.

      It re-checks the store before spending, which paid immediately: 3 of 11
      gaps were already covered (JTC Summit twice, MOE BUILDING) and closed for
      nothing. They were recorded while the name matcher returned the wrong row,
      fixed 08-23 — a queue that predates a matcher fix is partly a list of
      questions already answered.

      First real run: 3 saved (JW Marriott South Beach, from the operator's own
      site; Changi Airport T1; Solaris), 2 refused correctly — Shaw Theatres
      Jewel because the results were general airport rates, not the cinema's. A
      refusal does NOT resolve the gap: failing to find an answer is not the
      same as the question needing none.
      `from: carpark agent · 0dd0e85`

- [ ] **109 rows without coordinates never surface — 29 of them JTC**
      They are in the store but cannot be ranked by distance, so they are
      invisible to search regardless of how good their rates are. Some PDF
      blocks were also skipped by the extractor.

      Measured on the droplet 2026-09-20 with `scripts/uncoordinatedRows.ts`:
      **109 of 1187** rows, 107 `operator-site` and 2 `web-llm`. JTC is 29 of
      them, so the heading this task carried named a quarter of the problem. They
      are not gaps — the work of finding these prices was already done and paid
      for; they are answers the app cannot reach.

      **NONE of the 109 carries its own postal code**, which is what makes this
      hard rather than a loop. OneMap answers a postal exactly and a name only
      fuzzily, so all 109 need the judged kind of lookup — which means this task
      is blocked behind the OneMap task below rather than independent of it.
      Backfilling them by name with today's geocoder is precisely how Changi
      General Hospital and The Mill acquired the wrong coordinates in the first
      place.
      `from: carpark agent · own backlog · measured 2026-09-20`

- [x] **Bays no car may park in were listed as parking — done 2026-09-20**
      "Golden Mile Tower Loading Bay" reached a card as an ordinary option.
      Nine rows: five goods-vehicle loading bays and four Changi coach stands.
      EPS inventories everything behind the barrier system, not just public
      parking. 1586 surfaced rows became 1577, and Golden Mile Tower ITSELF
      still surfaces — the bay went, not the building.

      Found while fixing it that `search.ts` kept its OWN copy of the test and
      the two had drifted in both directions: EPS knew loading bays, coach
      stands and containers but not HVP; search knew HVP and neither of the
      others. So the first fix covered EPS cards only, and a saved rate named
      "… Loading Bay" would still have been listed. Both now import
      `src/lib/notForCars.ts`; the test groups its cases by which copy used to
      miss them. Third instance this month of two copies of one rule.
      `from: owner report · 2026-09-20 · adf1fd9, 8176255`

- [x] **Havelock2 was listed but unreachable — done 2026-09-20**
      Reported as "not listed". It WAS listed, twice wrong. EPS files it as
      "HAVELOCK II" while the stored LTA rate is filed under the name
      HAVELOCK2, and the matcher compares HAVELOCKII against HAVELOCK2 —
      Roman numeral against digit, neither containing the other — so no rate
      bound and an unpriced card sorts below every priced one.

      It was also pinned on the wrong building: EPS files postal 058763, which
      OneMap answers with Kreta Ayer Conservation Area, and the row's
      coordinates are that answer to the last decimal — geocoded from a typo of
      059763, 443 m south.

      The order mattered. An alias makes the override match EXACTLY, and
      `chooseNameMatch` skips the 1 km location veto for an exact match, so
      fixing the name first would have bound a rate to the wrong building with
      the guard standing aside — MOE (Evans Road) rebuilt. Coordinates went
      first, via `eps-locations-manual.json` so a re-scrape cannot reinstate the
      typo. The production row's display name was corrected on the droplet.
      `from: owner report · 2026-09-20 · adf1fd9`

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
