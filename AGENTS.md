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

## Private brands are DATA on the server — never commit them

This repo is **public** and is deliberately **single-brand (Carpark SG)**.

The same app also serves private skins on other hostnames. Their identity —
name, tagline, palette, artwork — lives entirely on the droplet, in files the
deploy never touches:

- `/home/deploy/carpark-brands.json` — the brand data
- `/home/deploy/carpark-brand/` — the artwork it names

Both sit **beside** the repo, not inside it. Anything inside the app tree is
deletable by `git reset --hard` and by phase 2's `rsync --delete`.

**Rules:**

1. **Never commit a private brand's data** — no name, tagline, palette, logo,
   or hostname. If you find yourself typing one into a tracked file, stop: it
   belongs in the JSON.
2. **Never delete the brand seams.** `src/lib/brand.ts` (types, `DEFAULT_BRAND`,
   `paletteCss`), `src/lib/brand-config.ts`, the palette `<style>` in
   `layout.tsx`, `BrandHeading` in `page.tsx`, and `src/app/brand/*` exist so a
   brand can arrive at runtime. This repo defines one brand, so they can all
   look like indirection with no purpose. Removing any of them silently
   un-brands a live site that this repo cannot see.
3. **Brand code must never name a brand.** Every seam above is generic: it asks
   "does this brand have artwork?", never "is this the anne brand?". A
   conditional on a specific key is the bug this design removed.

### Changing a brand needs no deploy

Edit the JSON on the droplet and restart. The config is read once per process,
so a restart is what picks it up:

```bash
sudo systemctl restart carpark
```

Shape (any number of brands; `logo` and `icon` are optional and must be bare
filenames inside the assets directory):

```json
{
  "brands": [
    {
      "key": "example",
      "hosts": ["example.com"],
      "name": "Example",
      "shortName": "Ex",
      "description": "...",
      "tagline": "...",
      "logo": "logo.png",
      "icon": "icon.png",
      "palettes": {
        "dark":  { "bg": "#000", "surface": "#111", "border": "#222",
                   "text": "#eee", "muted": "#999", "accent": "#f80" },
        "light": { "bg": "#fff", "surface": "#fff", "border": "#ddd",
                   "text": "#111", "muted": "#666", "accent": "#c60" }
      }
    }
  ]
}
```

Paths are overridable with `CARPARK_BRANDS_FILE` and `CARPARK_BRAND_ASSETS`.
A missing file is normal and silent — that is any deployment with no private
brand. A file that exists but is malformed logs `[brand]` with every problem at
once and falls back to the default, rather than half-applying.

### Both palettes are required, and that is deliberate

A brand supplies `dark` and `light`. `layout.tsx` emits both, in four blocks —
default, `prefers-color-scheme`, and an explicit `[data-theme]` pair that
outscores the other two so the theme toggle wins.

That last pair is not decoration. The earlier design declared brand colours on
`body[data-brand]`, a *descendant* of the `<html>` the toggle writes to, so the
brand won every cascade and the toggle did nothing on that host — it followed
the OS only, which looks like a working theme until someone presses a button.
Emitting on `:root` makes that structurally impossible.

`globals.css` deliberately does **not** declare the six brand variables. Two
copies of a palette is how a site ends up half-branded. Change
`DEFAULT_BRAND` in `src/lib/brand.ts` instead.

### The deploy checks what a visitor sees

`scripts/deploy.sh` asks the running app, for every configured host, whether it
serves that brand's name. If one falls back to the default it **exits 1 after
the app is up** — availability is untouched, but the Actions run goes red.

That is deliberately an outcome check rather than a "did the config load?"
check, and it is deliberately red rather than a warning. The previous design
was a git patch re-applied on every deploy, and it failed twice in one day:
once when an edit touched the same lines it patched, once when the app grew a
feature its CSS predated. Both printed a warning inside a green run, which
nobody reads. The site was found unbranded by looking at it.

Verify a theme change by clicking the real toggle and reading
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

## Billable calls are logged for the box-level dashboard

Every paid call appends one line to `/var/lib/usage/carpark.jsonl` via
`recordUsage()` in `src/lib/usage.ts`. The gtfoo repo reads all four apps'
files and renders `/admin/usage`, so **the field names are its contract, not
ours** — `Call` in `gtfoo/src/lib/usage.ts` is the source of truth. Renaming a
field here shows up as a wrong number on someone else's dashboard, never as an
error here, which is what `tests/usage.test.ts` exists to catch.

Four rules that are about honesty rather than format:

1. **`usd: null`, never `0`, when a call has no dollar cost.** Free-tier Gemini
   costs nothing; "$0.00" implies a measurement nobody took. The dashboard
   renders those groups as "free tier" and counts requests instead.
2. **Record failures too, and separate `rate_limited` from `error`.** On a free
   tier that 429 line is the *only* trustworthy evidence of where the
   undocumented ceiling sits. `generateObjectFallback` logs one line per
   ATTEMPT, so a model that gets exhausted leaves a trace even when the next
   model in the chain rescues the request.
3. **Log the model that answered, not the alias asked for.** `LLM_MODELS` is a
   fallback chain and `gemini-flash-latest` is a moving target, so the two
   differ exactly when something interesting happened.
4. **`units` is for providers not billed on tokens** — Tavily credits. Null for
   LLM calls.

Emission is best-effort by design: `recordUsage` never throws and never blocks
a user request on telemetry. If `/var/lib/usage` is missing or unwritable it
logs one `[usage]` warning and turns itself off for the process — the directory
lives under `/var/lib` and is created box-side, not by this app.

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
