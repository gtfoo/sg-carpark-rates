/**
 * Test the LLM web lookup from the terminal.
 *
 *   npm run lookup "Jewel Changi Airport"
 *   npm run lookup "Changi Airport Terminal 3" --postal 819663
 *
 * Reads GOOGLE_GENERATIVE_AI_API_KEY (and LLM_PROVIDER/LLM_MODEL) from
 * .env.local. Prints the found rate + sources; does NOT hide the API key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m || !m[1]) continue;
        if (process.env[m[1]] === undefined) {
          process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      /* absent — fine */
    }
  }
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  let postal: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--postal") postal = argv[++i] ?? null;
    else words.push(argv[i]!);
  }
  const destination = words.join(" ");

  if (!destination) {
    console.error('Usage: npm run lookup "<destination>" [--postal 123456]');
    process.exit(1);
  }

  const { isLlmConfigured } = await import("../src/lib/llm");
  const { isSearchConfigured } = await import("../src/lib/websearch");
  if (!isLlmConfigured()) {
    console.log("Missing GOOGLE_GENERATIVE_AI_API_KEY in .env.local (extraction).");
    console.log("Free key: https://aistudio.google.com/apikey");
    process.exit(1);
  }
  if (!isSearchConfigured()) {
    console.log("Missing TAVILY_API_KEY in .env.local (web search).");
    console.log("Free key (no card): https://tavily.com");
    process.exit(1);
  }

  console.log(`Looking up "${destination}"${postal ? ` (${postal})` : ""}…\n`);
  // Geocode so the saved rate gets coordinates (enables proximity matching).
  const { geocode } = await import("../src/lib/onemap");
  const place = await geocode(destination).catch(() => null);
  const { lookupCarparkRate } = await import("../src/lib/lookup");
  const result = await lookupCarparkRate({
    destination,
    postal: postal ?? place?.postal ?? null,
    lat: place?.location.lat ?? null,
    lng: place?.location.lng ?? null,
  });

  if (!result.found) {
    console.log(`No rate found. ${result.reason ?? ""}`);
    if (result.sources.length) {
      console.log("\nSources consulted:");
      for (const s of result.sources) console.log(`  ${s}`);
    }
    return;
  }

  const o = result.override!;
  console.log(`FOUND — saved rate #${o.id} for "${o.displayName}"`);
  console.log(`  weekday : ${o.weekdayRate ?? "-"}`);
  console.log(`  sat     : ${o.saturdayRate ?? "-"}`);
  console.log(`  sun/ph  : ${o.sundayPhRate ?? "-"}`);
  console.log(`  source  : ${o.source}  ${o.sourceUrl ?? ""}`);
  console.log(`  notes   : ${o.notes ?? "-"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
