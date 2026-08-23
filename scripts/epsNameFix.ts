/**
 * Proposes better display names for EPS carparks filed under an opaque code.
 *
 *   npx tsx scripts/epsNameFix.ts            # report only
 *   npx tsx scripts/epsNameFix.ts --write    # write src/lib/sources/eps-aliases.json
 *
 * EPS files some carparks under an internal reference. `displayName()` already
 * rewrites the ones that LOOK like references — its test requires a digit
 * somewhere ("URA_P0075", "TP57_TP59"), which is what keeps real names such as
 * "AMOY ST" out. Purely alphabetic codes slip through: "TLF" reaches a card as
 * "Tlf", and "BTC / NUS" as "Btc / Nus".
 *
 * The address does not rescue those, because it repeats the code back:
 * "1, CLUNY ROAD, TLF, Singapore 259569". The POSTAL CODE does. 259569 is
 * Singapore Botanic Gardens, which is what TLF actually is.
 *
 * Why a generated file rather than a runtime lookup: the EPS list is static and
 * these are 50-odd rows, so resolving them on every request would add a network
 * call per card to answer a question whose answer never changes. It also means
 * a human reads the diff before a name changes on a card.
 *
 * Why postal and not a curated list of my own guesses: most of these acronyms
 * are REAL names — AMK HUB, NEX, IMM, JEM, LOT ONE, CITY GATE, SOTA — and a
 * rule based on shape alone renames those too. Asking OneMap what stands at the
 * postal code is evidence; deciding "TLF looks fake and NEX looks real" is not.
 */
import fs from "node:fs";
import path from "node:path";
import { publicEpsCarparks } from "../src/lib/sources/eps";
import { geocode, suggest } from "../src/lib/onemap";

const OUT = path.join("src", "lib", "sources", "eps-aliases.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OneMap sometimes answers a postal with the address itself rather than a
 * building name — "500 CORPORATION ROAD SINGAPORE 649808" for NKF. An address
 * is not a better name than an acronym: it is longer, it is what the address
 * field already says, and it loses the only identity the row had.
 */
function isJustAnAddress(name: string): boolean {
  return /^\d/.test(name.trim()) || /\bSINGAPORE\s+\d{6}\b/i.test(name);
}

/**
 * A postal covering a whole site answers with whichever sub-feature happens to
 * sort first: 259569 is all of the Botanic Gardens, and TLF resolved to
 * "SINGAPORE BOTANIC GARDENS (BANDSTAND GAZEBO)" — a real gazebo, not the car
 * park. When several features under one postal share a prefix before their
 * parenthetical, that shared prefix IS the site, so use it.
 */
async function siteName(postal: string, first: string): Promise<string> {
  const base = first.replace(/\s*\(.*\)\s*$/, "").trim();
  if (base === first || !base) return first;
  const others = await suggest(postal, 10).catch(() => []);
  const sharing = others.filter((o) => o.name.replace(/\s*\(.*\)\s*$/, "").trim() === base);
  return sharing.length >= 2 ? base : first;
}

/**
 * Renames a human read and rejected. Kept here, with reasons, because the point
 * of generating this file is that somebody looks at the diff — an exclusion
 * with no reason is indistinguishable from a bug.
 *
 * A better heuristic would not have caught these. Token overlap does not
 * separate them from the good ones: "CCK CHOA CHU KANG PARK" SHARES three
 * words with the wrong answer, while "TLF" shares none with the right one.
 */
const REJECTED: Record<string, string> = {
  // 1 Hampshire Road is LTA's HQ, so the postal answers with its block
  // reference. A block number is not a better name than "HSO CAR PARK", and
  // the doubled parenthetical reads as broken.
  "HSO CAR PARK": "resolves to BLK 1 (LAND TRANSPORT AUTHORITY) (LTA)",
  // Wrong place. The address carries a placeholder house number ("0, CHOA CHU
  // KANG DRIVE"), so the postal belongs to a petrol station nearby rather than
  // to the park's car park.
  "CCK CHOA CHU KANG PARK": "resolves to SHELL CHOA CHU KANG, a different site",
  // Drops the article and collides with "ICON @ IBP", which is a genuinely
  // different car park in this same list.
  "THE ICON": "resolves to ICON, which is already another entry",
};

/** Bare-acronym shape: no digit anywhere, every token four letters or fewer. */
function looksLikeBareCode(name: string): boolean {
  const toks = name.toUpperCase().split(/[\s/_-]+/).filter(Boolean);
  if (!toks.length || /\d/.test(name)) return false;
  return toks.every((t) => t.length <= 4);
}

/** Compare ignoring case, spacing and punctuation. */
const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function main() {
  const write = process.argv.includes("--write");
  const candidates = publicEpsCarparks.filter((c) => looksLikeBareCode(c.name));
  console.log(`${candidates.length} EPS carpark(s) with a bare-acronym name\n`);

  const aliases: Record<string, string> = {};
  const unchanged: string[] = [];
  const noAnswer: string[] = [];

  for (const c of candidates) {
    const postal = String(c.postal ?? "").trim();
    if (!/^\d{6}$/.test(postal)) {
      noAnswer.push(`${c.name} (no postal)`);
      continue;
    }
    // OneMap throttles: an unpaced run resolved the first nine and then failed
    // every remaining call, which a bare .catch(() => null) reported as "no
    // building" — 54 fabricated negatives that looked exactly like data.
    let g = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3 && !g; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        g = await geocode(postal);
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(350);
    const building = g?.name?.trim() ?? "";
    if (!building || building.toUpperCase() === "NIL") {
      noAnswer.push(`${c.name} (${postal} -> ${lastErr || "no building"})`);
      continue;
    }
    if (isJustAnAddress(building)) {
      noAnswer.push(`${c.name} (${postal} -> only an address: ${building})`);
      continue;
    }
    const resolved = await siteName(postal, building);
    await sleep(350);

    // The postal usually resolves to the SAME name, which is the check working:
    // NEX, IMM and JEM are what stands at their postal codes.
    if (key(resolved) === key(c.name)) {
      unchanged.push(c.name);
      continue;
    }
    const veto = REJECTED[c.name.toUpperCase()];
    if (veto) {
      noAnswer.push(`${c.name} (rejected on review: ${veto})`);
      continue;
    }
    aliases[c.id] = resolved;
    console.log(`  "${c.name}"  ->  "${resolved}"`);
    console.log(`      postal ${postal}   was: ${c.address}`);
  }

  console.log(`\n  renamed: ${Object.keys(aliases).length}`);
  console.log(`  postal agrees with the existing name (left alone): ${unchanged.length}`);
  console.log(`    ${unchanged.join(", ")}`);
  console.log(`  no usable answer (left alone): ${noAnswer.length}`);
  for (const n of noAnswer) console.log(`    ${n}`);

  if (!write) {
    console.log(`\n  Report only. Re-run with --write to update ${OUT}.`);
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(aliases, null, 2) + "\n");
  console.log(`\n  wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
