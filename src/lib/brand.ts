/**
 * Brand identity: types, the built-in default, and pure helpers.
 *
 * This file is deliberately data-free beyond the default brand. Additional
 * brands are supplied at RUNTIME from a file outside the repo (see
 * `brand-config.ts`) so a private skin can exist on a server without existing
 * in a public git history.
 *
 * Everything here is pure and isomorphic — no `fs`, no `headers()` — so it can
 * be imported from client components and unit-tested directly.
 */

/** The six colours a brand controls. Everything else is semantic and lives in globals.css. */
export interface Palette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
}

export interface Brand {
  key: string;
  name: string;
  /** Home-screen label — keep short so iOS/Android don't truncate it. */
  shortName: string;
  description: string;
  tagline: string;
  /**
   * Filenames of server-held assets, served back as /brand/logo and
   * /brand/icon. Absent for a brand that has no artwork, which then renders
   * its wordmark instead. Never a path — see `assetName`.
   */
  logo?: string;
  icon?: string;
  palettes: { dark: Palette; light: Palette };
}

export const PALETTE_KEYS = [
  "bg",
  "surface",
  "border",
  "text",
  "muted",
  "accent",
] as const satisfies readonly (keyof Palette)[];

/**
 * The public brand. Its palette is the single source of truth for these six
 * colours — globals.css deliberately no longer declares them, so there is no
 * second copy to drift.
 */
export const DEFAULT_BRAND: Brand = {
  key: "carpark",
  name: "Carpark SG",
  shortName: "Carpark",
  description: "Nearby Singapore carparks, rates and availability",
  tagline: "Nearby carparks, rates and live availability",
  palettes: {
    dark: {
      bg: "#0b0d10",
      surface: "#14181d",
      border: "#232a32",
      text: "#e8eaed",
      muted: "#9aa4b2",
      accent: "#5b8cff",
    },
    light: {
      bg: "#f6f7f9",
      surface: "#ffffff",
      border: "#dfe3e8",
      text: "#12151a",
      muted: "#5a6472",
      accent: "#2f6bff",
    },
  },
};

/**
 * A CSS colour we are willing to interpolate into a <style> tag.
 *
 * The config file is server-owned, so this is not the security boundary it
 * would be for user input — but it is the difference between a typo showing up
 * as one wrong colour and a stray `}` silently breaking every rule after it.
 */
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|[a-z]+)$/i;

export function isColour(value: unknown): value is string {
  return typeof value === "string" && COLOUR.test(value.trim());
}

/**
 * Asset filenames must be a bare basename. The routes that serve them join
 * this onto a directory, so anything with a separator or a `..` would let the
 * config read outside the assets directory.
 */
export function isAssetName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.startsWith(".")
  );
}

export interface BrandEntry extends Brand {
  /** Hostnames this brand answers to. Matched case-insensitively, port stripped. */
  hosts: string[];
}

/** Thrown with a list of everything wrong, so one bad file reports once. */
export class BrandConfigError extends Error {}

function palette(raw: unknown, where: string, problems: string[]): Palette | null {
  if (!raw || typeof raw !== "object") {
    problems.push(`${where} is missing`);
    return null;
  }
  const src = raw as Record<string, unknown>;
  const out = {} as Palette;
  for (const k of PALETTE_KEYS) {
    if (!isColour(src[k])) {
      problems.push(`${where}.${k} is not a colour (${JSON.stringify(src[k])})`);
      continue;
    }
    out[k] = (src[k] as string).trim();
  }
  return out;
}

function text(src: Record<string, unknown>, k: string, where: string, problems: string[]): string {
  const v = src[k];
  if (typeof v !== "string" || !v.trim()) {
    problems.push(`${where}.${k} must be a non-empty string`);
    return "";
  }
  return v;
}

/**
 * Validates the brands file. Returns every problem at once rather than
 * failing on the first: a half-valid brand file that silently drops the logo
 * is exactly the failure mode this whole design exists to remove.
 */
export function parseBrands(raw: unknown): BrandEntry[] {
  const problems: string[] = [];
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const list = root?.brands;
  if (!Array.isArray(list)) throw new BrandConfigError('expected { "brands": [ ... ] }');

  const brands: BrandEntry[] = [];
  list.forEach((item, i) => {
    const where = `brands[${i}]`;
    if (!item || typeof item !== "object") {
      problems.push(`${where} is not an object`);
      return;
    }
    const src = item as Record<string, unknown>;
    const hosts = Array.isArray(src.hosts) ? src.hosts.filter((h) => typeof h === "string") : [];
    if (!hosts.length) problems.push(`${where}.hosts must list at least one hostname`);

    const dark = palette((src.palettes as Record<string, unknown>)?.dark, `${where}.palettes.dark`, problems);
    const light = palette((src.palettes as Record<string, unknown>)?.light, `${where}.palettes.light`, problems);

    for (const k of ["logo", "icon"] as const) {
      if (src[k] !== undefined && !isAssetName(src[k])) {
        problems.push(`${where}.${k} must be a bare filename, not a path`);
      }
    }

    const brand: BrandEntry = {
      key: text(src, "key", where, problems),
      name: text(src, "name", where, problems),
      shortName: text(src, "shortName", where, problems),
      description: text(src, "description", where, problems),
      tagline: text(src, "tagline", where, problems),
      hosts: hosts.map((h) => h.toLowerCase()),
      palettes: { dark: dark ?? DEFAULT_BRAND.palettes.dark, light: light ?? DEFAULT_BRAND.palettes.light },
    };
    if (isAssetName(src.logo)) brand.logo = src.logo;
    if (isAssetName(src.icon)) brand.icon = src.icon;
    brands.push(brand);
  });

  if (problems.length) throw new BrandConfigError(problems.join("; "));
  return brands;
}

/** Strips the port and lowercases, so `Host: example.com:3001` still matches. */
export function normaliseHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

export function brandForHost(host: string | null | undefined, brands: readonly BrandEntry[]): Brand {
  const h = normaliseHost(host);
  return brands.find((b) => b.hosts.includes(h)) ?? DEFAULT_BRAND;
}

/**
 * The brand's palette as CSS, mirroring the four-block structure in
 * globals.css: default dark, system light, then the two explicit choices that
 * must outscore both so the theme toggle actually wins.
 *
 * Selectors are doubled (`:root:root`) rather than relying on this tag coming
 * after the stylesheet. Next controls where it injects the stylesheet link, so
 * source order is not ours to depend on; specificity is.
 */
export function paletteCss(brand: Brand): string {
  const vars = (p: Palette) => PALETTE_KEYS.map((k) => `--${k}:${p[k]}`).join(";");
  const dark = vars(brand.palettes.dark);
  const light = vars(brand.palettes.light);
  return [
    `:root:root{${dark}}`,
    `@media (prefers-color-scheme:light){:root:root:not([data-theme="dark"]){${light}}}`,
    `:root:root[data-theme="dark"]{${dark}}`,
    `:root:root[data-theme="light"]{${light}}`,
  ].join("");
}
