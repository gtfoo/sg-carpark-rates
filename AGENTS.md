# Working on carpark-sg

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

## One agent at a time

This repo has been edited by two AI chat windows at once, which caused
duplicated work and a reverted feature. Before starting, run `git log --oneline -5`
and `git status`; if another session is mid-change, coordinate rather than
editing the same files (especially `src/app/page.tsx`).

## Deploying

Push to `main` → GitHub Actions SSHes to the droplet and runs `scripts/deploy.sh`
(hard-reset, re-apply branding patch, `npm ci`, build, restart `carpark.service`).
`.env.local` and `data/` are gitignored and survive deploys.
