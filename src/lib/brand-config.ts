/**
 * Loads additional brands from a file OUTSIDE the repository.
 *
 * Server-only — it touches `fs`. Import it from server components and route
 * handlers; client components receive a resolved `Brand` as a prop instead.
 *
 * Why outside the repo, and not a patch:
 *
 * A private skin used to be a git patch re-applied by the deploy. That put
 * brand data in the same files as application code, so any edit near it broke
 * the patch, and a broken patch un-branded the site silently. Data in a file
 * the deploy never touches cannot rot: `git reset --hard` doesn't reach it,
 * and neither does a `rsync --delete` of the repo tree.
 *
 * The default path is a SIBLING of the working directory for exactly that
 * reason. Anything inside the app tree is deletable by a deploy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BrandConfigError,
  brandForHost,
  parseBrands,
  type Brand,
  type BrandEntry,
} from "./brand";

export const BRANDS_FILE =
  process.env.CARPARK_BRANDS_FILE || path.join(process.cwd(), "..", "carpark-brands.json");

export const BRAND_ASSETS_DIR =
  process.env.CARPARK_BRAND_ASSETS || path.join(process.cwd(), "..", "carpark-brand");

let cache: BrandEntry[] | null = null;

/**
 * Reads and validates the brands file once per process.
 *
 * A missing file is normal and silent — that is the public deployment, which
 * has no second brand. A file that exists but is malformed is NOT silent: it
 * logs loudly and falls back to the default brand, because the whole point of
 * this design is that a branding failure is visible rather than a site that
 * quietly looks like the wrong product.
 */
export function loadBrands(): BrandEntry[] {
  if (cache) return cache;
  let raw: string;
  try {
    raw = readFileSync(BRANDS_FILE, "utf8");
  } catch {
    return (cache = []);
  }
  try {
    cache = parseBrands(JSON.parse(raw));
  } catch (err) {
    const why = err instanceof BrandConfigError || err instanceof SyntaxError ? err.message : String(err);
    console.error(`[brand] ignoring ${BRANDS_FILE}: ${why}`);
    cache = [];
  }
  return cache;
}

/** The brand for a request's Host header, falling back to the public one. */
export function resolveBrand(host: string | null | undefined): Brand {
  return brandForHost(host, loadBrands());
}

/** Absolute path of a brand asset, or null when the brand declares none. */
export function brandAssetPath(brand: Brand, which: "logo" | "icon"): string | null {
  const name = brand[which];
  return name ? path.join(BRAND_ASSETS_DIR, name) : null;
}

/** Test seam — the cache is per-process and would otherwise outlive a test. */
export function resetBrandCache(): void {
  cache = null;
}
