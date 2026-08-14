import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BrandConfigError,
  DEFAULT_BRAND,
  brandForHost,
  isAssetName,
  isColour,
  normaliseHost,
  paletteCss,
  parseBrands,
  type BrandEntry,
} from "../src/lib/brand";

/**
 * These cover the seam a private brand hangs off. Every case here is a way the
 * old git-patch approach failed silently: a host that didn't match, a palette
 * that didn't answer the theme toggle, artwork that pointed somewhere it
 * shouldn't. A brand that half-loads must be an error, never a quiet fallback.
 */

// Deliberately absurd colours. An earlier version of this file used a real
// private brand's palette as the fixture, which put its identity in a public
// repo — the exact thing AGENTS.md rule 1 forbids, in the file that tests it.
const goodPalette = {
  bg: "#010203",
  surface: "#040506",
  border: "#070809",
  text: "#fafbfc",
  muted: "#888888",
  accent: "#abcdef",
};

function config(over: Record<string, unknown> = {}) {
  return {
    brands: [
      {
        key: "second",
        hosts: ["second.example.com"],
        name: "Second Brand",
        shortName: "Second",
        description: "d",
        tagline: "t",
        palettes: { dark: goodPalette, light: { ...goodPalette, bg: "#fedcba" } },
        ...over,
      },
    ],
  };
}

test("a valid config parses and matches its host", () => {
  const brands = parseBrands(config());
  assert.equal(brands.length, 1);
  assert.equal(brandForHost("second.example.com", brands).name, "Second Brand");
});

test("an unknown host falls back to the public brand", () => {
  const brands = parseBrands(config());
  assert.equal(brandForHost("carpark.example.com", brands).key, DEFAULT_BRAND.key);
  assert.equal(brandForHost(null, brands).key, DEFAULT_BRAND.key);
});

test("host matching ignores case and port", () => {
  // A request arriving as `Host: Second.Example.com:3001` is the same site.
  const brands = parseBrands(config());
  assert.equal(brandForHost("Second.Example.com:3001", brands).name, "Second Brand");
  assert.equal(normaliseHost("EXAMPLE.com:80"), "example.com");
});

test("a malformed palette is an error, not a half-applied brand", () => {
  assert.throws(
    () => parseBrands(config({ palettes: { dark: { ...goodPalette, bg: "}" }, light: goodPalette } })),
    BrandConfigError,
  );
});

test("every problem is reported at once, not just the first", () => {
  try {
    parseBrands(config({ name: "", hosts: [] }));
    assert.fail("expected a BrandConfigError");
  } catch (err) {
    assert.ok(err instanceof BrandConfigError);
    assert.match(err.message, /name/);
    assert.match(err.message, /hosts/);
  }
});

test("artwork must be a bare filename — no path escapes the assets directory", () => {
  for (const bad of ["../../etc/passwd", "sub/dir.png", ".hidden"]) {
    assert.throws(() => parseBrands(config({ logo: bad })), BrandConfigError, bad);
  }
  assert.ok(isAssetName("logo.png"));
  assert.ok(!isAssetName("a/b.png"));
});

test("a brand without artwork simply has none", () => {
  const brand = parseBrands(config())[0];
  assert.ok(brand);
  assert.equal(brand.logo, undefined);
  assert.equal(brand.icon, undefined);
});

test("colours are validated before being interpolated into CSS", () => {
  assert.ok(isColour("#abc"));
  assert.ok(isColour("rgb(1, 2, 3)"));
  assert.ok(!isColour("red;} body{display:none"));
  assert.ok(!isColour(""));
});

test("the emitted CSS answers the theme toggle, not just the system setting", () => {
  // The bug this pins: a palette that only defines the default and the
  // prefers-color-scheme block leaves the toggle inert, because an explicit
  // choice has nothing scoped to it.
  const brand: BrandEntry | undefined = parseBrands(config())[0];
  assert.ok(brand);
  const css = paletteCss(brand);
  assert.match(css, /\[data-theme="light"\]/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme:light/);
  // The explicit blocks must outscore the media query, or the system wins.
  assert.match(css, /:root:root\[data-theme="light"\]\{[^}]*--bg:#fedcba/);
});

test("the default brand needs no config file at all", () => {
  assert.equal(brandForHost("anything.example.com", []).key, DEFAULT_BRAND.key);
  assert.match(paletteCss(DEFAULT_BRAND), /--bg:#0b0d10/);
});

test("a config that is not the expected shape is rejected outright", () => {
  assert.throws(() => parseBrands({}), BrandConfigError);
  assert.throws(() => parseBrands([]), BrandConfigError);
});
