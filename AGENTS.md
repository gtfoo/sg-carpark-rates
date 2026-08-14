# Working on carpark-sg

## Shared droplet contract

Infra facts, the deploy lock, ownership, and the current phase are shared
across all four apps and maintained by the droplet agent. Read, don't edit.

@~/Git/INFRA.md

Live correspondence with the droplet agent lives in `MAIL.md`, not here — read
it when you're picking up cross-app work. It is deliberately not imported: this
file is app rules, and mail goes stale.

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
   it on every deploy (the deploy hard-resets the tree, so this is required).
   An edit *near* the branded lines is re-anchored automatically by a 3-way
   apply; an edit to *the same lines* cannot be, and then the deploy still
   ships and serves — but **exits 1 so the Actions run goes red.** A red run is
   the signal. It used to be a warning inside a green run, which nobody sees:
   that is exactly how her site sat unbranded for a day in Aug 2026.

To refresh the patch after the app's structure changes, on the droplet:

```bash
cd /home/deploy/carpark
git apply -3 ../carpark-anne.patch      # -3 re-anchors moved context
# resolve any conflict markers by hand, keeping BOTH sides' intent
git diff HEAD > ../carpark-anne.patch   # NOT `git diff` — see below
```

**`git diff HEAD`, never plain `git diff`.** A 3-way apply *stages* every file
it merged cleanly, so plain `git diff` shows only the file you hand-resolved.
It regenerates happily, exits 0, and silently produces a patch with four of the
five files missing — which then applies cleanly and un-brands almost
everything. Verify a regenerated patch by applying it to a throwaway worktree
and reading the result, not by trusting that it applied:

```bash
git worktree add -f --detach /tmp/brandproof HEAD
cd /tmp/brandproof && git apply ../carpark-anne.patch && grep -c anne src/lib/brand.ts
```

**Never check the patch inside `/home/deploy/carpark` itself.** A deploy leaves
it *applied*, so that working tree permanently carries the five modified files
between deploys, and `git apply --check` there fails with "patch does not
apply" for all five — whether the patch is good or not. It looks exactly like
the failure you would be checking for. Always check against a clean worktree,
as above; the deploy hard-resets before applying, so a clean tree is what the
patch actually meets.

**Also: the brand palette must answer the theme toggle.** The toggle writes
`data-theme` on `<html>`, but a brand palette is declared on `body[data-brand]`
— a descendant, so it wins every cascade and the toggle silently does nothing
on that host. A brand needs four palette rules, not two: the plain one, the
`prefers-color-scheme` one, and a `:root[data-theme="dark|light"] body[...]`
pair that outscores both. Verify by clicking the real toggle and reading
`getComputedStyle(document.body)`, not by grepping the built CSS — the minifier
strips quotes from attribute selectors, so `[data-theme="light"]` ships as
`[data-theme=light]` and a naive grep reports a correct deploy as missing.

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

The workflow's `paths-ignore` skips the deploy for `**.md`, `.env.example`,
`.gitignore` and `.github/**`. Do not add `scripts/**` — the deploy is how
import scripts reach the droplet, and they're run there by hand right after a
push. Do not add `tests/**` either: `paths-ignore` skips the *whole* workflow
including the test job, which would silence the corpus gate on exactly the
commits that move it.
