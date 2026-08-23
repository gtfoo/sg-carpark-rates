/**
 * Fetches every AI-retrieved rate's `source_url` and reports the dead ones.
 *
 *   npx tsx scripts/citationAudit.ts
 *   npx tsx scripts/citationAudit.ts --fix     # null out the dead ones
 *
 * A rate's citation is the only thing a human can use to check it. Until
 * `citedUrl()` landed, the extraction model was free to answer the schema's
 * "most authoritative URL" with one it composed: Midview City was stored
 * against `midviewcity.com/midview-city-parking-charges` — domain from the
 * building name, slug from the topic — a host that fails its TLS handshake and
 * 404s over plain HTTP.
 *
 * That is a worse failure than an empty citation, because it inverts the
 * signal. A row citing a listing site looks weakly sourced and invites a
 * check; a row citing what appears to be the operator's own rates page looks
 * settled, and is the one nobody re-opens.
 *
 * `citedUrl` stops NEW ones. This finds the rows already written, which no
 * amount of care at the write path can reach.
 *
 * Deliberately NOT a CI gate, unlike `rateAudit --ci`: it makes one network
 * request per row to third-party sites. A site being down for an afternoon is
 * not a defect in this repo, and a red build for it would train everyone to
 * ignore the check.
 */
import { getDb } from "../src/lib/db";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type Row = { id: number; name: string; source: string; source_url: string };

/**
 * Reachability, not correctness — this cannot tell whether the page actually
 * mentions the carpark, only whether anything is served at all.
 *
 * HEAD first, then GET on failure: plenty of sites 405 a HEAD while serving
 * the GET perfectly well, and reporting those as dead would be the same
 * cry-wolf failure as the security panel that flagged 16 harmless redirects.
 * A TLS error counts as dead — Midview's host is exactly that, and a URL a
 * browser refuses to open is no use to a verifier.
 */
async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, {
        method,
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return { ok: true, detail: `${res.status}` };
      if (method === "GET") return { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      if (method === "GET") {
        const m = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: m.slice(0, 60) };
      }
    }
  }
  return { ok: false, detail: "unreachable" };
}

async function main() {
  const fix = process.argv.includes("--fix");
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, display_name AS name, source, source_url
         FROM rate_overrides
        WHERE source_url IS NOT NULL AND source_url <> ''
        ORDER BY id`,
    )
    .all() as Row[];

  console.log(`Probing ${rows.length} citation(s)…\n`);

  const dead: Array<Row & { detail: string }> = [];
  let live = 0;

  // Serial on purpose. This is a background chore against other people's
  // servers, and a burst of parallel requests from one IP is how you get the
  // droplet's address blocked for the app's real lookups.
  for (const r of rows) {
    const { ok, detail } = await probe(r.source_url);
    if (ok) {
      live++;
    } else {
      dead.push({ ...r, detail });
      console.log(`  DEAD  #${r.id} ${r.name}`);
      console.log(`        ${r.source_url}  (${detail})`);
    }
  }

  console.log(`\n  live: ${live}   dead: ${dead.length}   of ${rows.length}`);

  if (!dead.length) return;

  if (!fix) {
    console.log(`\n  Re-run with --fix to null these out.`);
    console.log(`  Nulling is the honest end state: the RATE may well be`);
    console.log(`  correct, so deleting the row would throw away good data —`);
    console.log(`  it is only the citation that was never real.`);
    return;
  }

  const upd = db.prepare(`UPDATE rate_overrides SET source_url = NULL WHERE id = ?`);
  const tx = db.transaction((list: Row[]) => list.forEach((r) => upd.run(r.id)));
  tx(dead);
  console.log(`\n  nulled ${dead.length} unverifiable citation(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
