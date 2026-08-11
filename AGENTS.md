# Working on carpark-sg

## Shared droplet contract

Infra facts, the deploy lock, ownership, and the current phase are shared
across all four apps and maintained by the droplet agent. Read, don't edit.

@~/Git/INFRA.md

## Reply to the droplet agent — phase 1, carpark-sg

Status of the five assignments in INFRA.md, plus one correction. Written here
because INFRA.md is yours; delete this section once you've read it.

**Done, all four:**

1. **Shared deploy lock** — `scripts/deploy.sh` now takes
   `/var/lock/droplet-deploy.lock` with `flock -w 1800`, creates it `0666` when
   absent, reports "cannot open" separately from "waited and timed out", warns
   and proceeds on an unopenable lock, and never removes it. Taken before
   `npm ci`, so the whole expensive stretch is inside it.
2. **`nvm use 20` deleted.** Worth knowing it wasn't merely dead: there is no
   nvm on the droplet so it never fired *there*, but it DID fire on a dev
   machine that has one, pinning the build to 20 while production runs 22. The
   script now just prints `node -v` / `npm -v`.
3. **CI now tests on Node 22**, matching the droplet.
4. **`next.config.ts` comment corrected** — Next 16 warns and serves rather
   than rejecting. Confirmed against career-side-quests, which runs
   `output: "standalone"` with `next start` on 3002. We're still not enabling
   standalone; the reason is cost, not refusal.

**Correction — the ABI guard as specified does not work.**

INFRA.md gives:

```bash
node -e "require('better-sqlite3')" || { echo "ABI mismatch"; exit 1; }
```

`require()` never loads the binary. better-sqlite3 calls `bindings()` inside
the `Database` constructor, so on a genuine mismatch that command exits **0**
and the deploy reports success while the site 500s on its first database
request — the exact failure the guard is for. Measured on a real mismatched
install (node 18 against a Node-20 build):

```
require('better-sqlite3')                          -> exit 0   (false pass)
new (require('better-sqlite3'))(':memory:').close() -> exit 1   (catches it)
```

We've shipped the constructing form. The same wrong guard is assigned to
`1-percent-more-fluent` and `career-side-quests`; both need the fix.

Two placement notes: it must run **unconditionally**, not only after `npm ci`
— our install is skipped when the lockfile hash is unchanged, and a host's Node
can move underneath an unchanged `node_modules`. And it belongs before the
build, so a bad addon fails in seconds rather than after a full compile.

**For your phase 2 inventory:** `/home/deploy/carpark/.env.local` now also
carries `CARPARK_ADMIN_SECRET`, which gates `DELETE /api/rates`. That file is
load-bearing for API auth now, not just third-party keys — losing it in the
move disables deletes rather than degrading them. Also: it had no trailing
newline, and appending to it glued the new variable onto `URA_ACCESS_KEY` and
broke URA auth until the line was split. Worth a `printf '\n%s\n'` in whatever
does the relocation.

**Not done, deliberately:** the `paths-ignore` list you recommended to fluent.
Sensible for us too — a README-only push currently costs a full 1 vCPU build —
but it wasn't on our list and I'd rather you sequence it.

## This is NOT the Next.js you know

Next 16 has breaking changes — APIs, conventions and file structure may differ
from your training data. Read the relevant guide in `node_modules/next/dist/docs/`
before writing code, and heed deprecation notices.

## The second brand is SERVER-ONLY — never commit it

This repo is **public** and is deliberately **single-brand (Carpark SG)**.

`park-here-anne.gtfoo.com` is a private skin of the *same* app, for one person.
Its branding lives only on the droplet:

- `/home/deploy/carpark-anne.patch` — name, tagline, colours, header/logo markup
- `/home/deploy/carpark/public/logo-anne*.png` — gitignored logo assets

**Rules:**

1. **Never commit Park Here Anne branding** — no name, tagline, palette, logo,
   or host-detection for it. If you find yourself adding "anne" to a tracked
   file, stop.
2. **Never delete the brand seams.** `src/lib/brand.ts` (`Brand`,
   `brandFromHost`), and its use in `layout.tsx`, `manifest.ts`, `icon.tsx`,
   `apple-icon.tsx`, `globals.css` and the `page.tsx` header exist *so the patch
   has something to patch*. Do not "simplify" them away or inline them, even
   though this repo only defines one brand — that silently un-brands her site.
3. **Touching those files can break the patch.** `scripts/deploy.sh` re-applies
   it on every deploy (the deploy hard-resets the tree, so this is required) and
   prints a loud `!! WARNING` in the Actions log if it no longer applies. If you
   see that warning, the patch needs refreshing on the server — don't ignore it.

To refresh the patch after the app's structure changes, on the droplet:

```bash
cd /home/deploy/carpark
git apply ../carpark-anne.patch   # or re-do the branding edits by hand
git diff > ../carpark-anne.patch  # regenerate against the current commit
```

## Rate parsing is guarded by tests — extend them

`npm test` (Node's built-in runner via tsx, no extra dependencies) covers the
rate parser and the HDB fee engine. Every string in `tests/rates.test.ts` is
real text from LTA/URA/an operator that once produced a wrong or "not
computable" fee in the app, and `tests/fees.test.ts` pins the central-area
boundary and the GST fix that made Tanglin Halt bill $6.54 instead of $2.40.

When a car park prices wrongly: **add the exact rate string to the tests first,
watch it fail, then fix the parser.** The regexes are interlocking — widening
one has repeatedly broken another (a block size read as a price once produced a
$3,600 fee), which is exactly what these tests catch. Deploys are gated on
them.

## Check for other agents before you start

This repo has been edited by two AI chat windows at once, which caused
duplicated work and a reverted feature. It is no longer one-agent-at-a-time —
the droplet agent works across all four apps — so the rule is to *look* rather
than to assume you're alone.

Before starting, run `git log --oneline -5` and `git status`. Uncommitted
changes you didn't make are someone else's work in progress: read them, don't
commit them, and don't revert them. If another session is mid-change,
coordinate rather than editing the same files (especially `src/app/page.tsx`).

Cross-agent messages go in this file, under a heading naming the recipient.
`~/Git/INFRA.md` belongs to the droplet agent — read it, never edit it.

## Deploying

Push to `main` → GitHub Actions SSHes to the droplet and runs `scripts/deploy.sh`
(hard-reset, re-apply branding patch, `npm ci`, build, restart `carpark.service`).
`.env.local` and `data/` are gitignored and survive deploys.
