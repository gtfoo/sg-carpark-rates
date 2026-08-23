/**
 * Probes every stored `source_url` and reports which citations can't be
 * checked by a human — separating "the page isn't there" from "the page won't
 * talk to US".
 *
 *   npx tsx scripts/citationAudit.ts
 *   npx tsx scripts/citationAudit.ts --list missing,unreachable
 *
 * A rate's citation is the only thing a reader can use to verify it. Until
 * `citedUrl()` landed, the extraction model could answer the schema's "most
 * authoritative URL" with one it composed: Midview City was stored against
 * `midviewcity.com/midview-city-parking-charges` — domain from the building
 * name, slug from the topic — a host that closes the connection outright and
 * 404s over plain HTTP.
 *
 * ## Why this reports and never fixes
 *
 * The first version of this script classified by "did `fetch` succeed" and
 * offered `--fix` to null the failures. On the real corpus it flagged **330 of
 * 1,152**, and all but two were wrong:
 *
 * - **300+ URA rows** cite the URA dataset endpoint. `curl` gets 200 from both
 *   the droplet and a home connection; Node's `fetch` throws `other side
 *   closed` on that host. The citations were perfect; the PROBE was broken.
 *   That is why this shells out to curl rather than using `fetch`.
 * - **Parkopedia (405) and CMPB (403)** answer a home connection with 200 and
 *   the droplet with a refusal. That is datacentre-IP blocking. The page
 *   exists; we are simply not welcome.
 *
 * So `--fix` would have destroyed 328 real citations to remove 2 fake ones. A
 * check that is wrong 99% of the time is worse than no check, because acting
 * on it does more damage than the defect it targets. Reachability is evidence,
 * not a verdict — a human reads this and decides.
 *
 * Not a CI gate either, for the same reason plus one more: it makes a request
 * per row to third-party sites, and a site being down for an afternoon is not
 * a defect in this repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "../src/lib/db";

const run = promisify(execFile);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type Verdict = "ok" | "blocked" | "missing" | "unreachable";
type Row = { id: number; name: string; source: string; source_url: string };

const EXPLAIN: Record<Verdict, string> = {
  ok: "served",
  blocked: "server refused US — page likely fine in a browser",
  missing: "server says this path does not exist",
  unreachable: "no usable connection — DNS, TLS or the host hanging up",
};

/**
 * curl, not `fetch`. Proven necessary: `eservice.ura.gov.sg` answers curl with
 * 200 and Node's undici with `other side closed`, and believing undici would
 * have condemned 300+ correct citations.
 */
async function probe(url: string): Promise<{ verdict: Verdict; detail: string }> {
  try {
    const { stdout } = await run(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-L", "--max-time", "25", "-A", UA, url],
      { timeout: 40000 },
    );
    const code = Number(stdout.trim());
    if (code === 0 || Number.isNaN(code)) return { verdict: "unreachable", detail: "no response" };
    if (code >= 200 && code < 400) return { verdict: "ok", detail: String(code) };
    if ([401, 403, 405, 429].includes(code)) return { verdict: "blocked", detail: `HTTP ${code}` };
    if ([404, 410].includes(code)) return { verdict: "missing", detail: `HTTP ${code}` };
    return { verdict: "blocked", detail: `HTTP ${code}` };
  } catch {
    return { verdict: "unreachable", detail: "probe failed" };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "(unparseable)";
  }
}

async function main() {
  const listArg = process.argv.find((a) => a.startsWith("--list"));
  const wanted = new Set<string>(
    (listArg?.split("=")[1] ?? "missing,unreachable").split(",").map((s) => s.trim()),
  );

  const rows = getDb()
    .prepare(
      `SELECT id, display_name AS name, source, source_url
         FROM rate_overrides
        WHERE source_url IS NOT NULL AND source_url <> ''
        ORDER BY id`,
    )
    .all() as Row[];

  // One probe per DISTINCT url. 300+ rows share the URA endpoint; probing it
  // 300 times would be slow, rude, and would report one broken host as 300
  // broken citations.
  const byUrl = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byUrl.get(r.source_url);
    if (list) list.push(r);
    else byUrl.set(r.source_url, [r]);
  }

  console.log(`${rows.length} citation(s) across ${byUrl.size} distinct URL(s)\n`);

  const results = new Map<string, { verdict: Verdict; detail: string; rows: Row[] }>();
  // Serial on purpose: a burst from one IP is how the droplet's address gets
  // blocked for the app's real lookups.
  for (const [url, group] of byUrl) {
    const { verdict, detail } = await probe(url);
    results.set(url, { verdict, detail, rows: group });
  }

  const tally: Record<Verdict, number> = { ok: 0, blocked: 0, missing: 0, unreachable: 0 };
  for (const { verdict, rows: g } of results.values()) tally[verdict] += g.length;

  console.log("  by rows:");
  for (const v of ["ok", "blocked", "missing", "unreachable"] as Verdict[]) {
    console.log(`    ${v.padEnd(12)} ${String(tally[v]).padStart(5)}   ${EXPLAIN[v]}`);
  }

  // A host that fails identically across many rows is one broken host, or one
  // host that dislikes us — not N bad citations. Saying so in the output is
  // the difference between a report and a false alarm.
  const badHosts = new Map<string, number>();
  for (const [url, { verdict, rows: g }] of results)
    if (verdict !== "ok") badHosts.set(hostOf(url), (badHosts.get(hostOf(url)) ?? 0) + g.length);
  const bulk = [...badHosts.entries()].filter(([, n]) => n >= 10).sort((a, b) => b[1] - a[1]);
  if (bulk.length) {
    console.log("\n  hosts failing in bulk — suspect the probe or an IP block, not the data:");
    for (const [h, n] of bulk) console.log(`    ${String(n).padStart(5)}  ${h}`);
  }

  const flagged = [...results.entries()].filter(([, r]) => wanted.has(r.verdict));
  if (flagged.length) {
    console.log(`\n  --- ${[...wanted].join(", ")} ---`);
    for (const [url, { verdict, detail, rows: g }] of flagged) {
      for (const r of g) console.log(`  ${verdict.toUpperCase()}  #${r.id} ${r.name}`);
      console.log(`        ${url}  (${detail})`);
    }
  }

  console.log(
    `\n  Nothing is changed by this script. Judge each row: an unreachable\n` +
      `  citation on a host nothing else uses is the fabrication signature —\n` +
      `  a bulk failure almost never is.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
