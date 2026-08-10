/**
 * RETIRED. This used to scrape car park rates off OneMotoring's pages, and it
 * must not do that again.
 *
 * OneMotoring's Terms of Use say its contents "shall not be reproduced,
 * republished, uploaded, posted, transmitted, communicated or otherwise
 * distributed in any way, without the prior written permission of LTA" — and
 * the scrape also got past a 403 by sending a browser user-agent. The 346 rows
 * it had written were replaced with the same car parks from LTA's open dataset
 * on data.gov.sg (Singapore Open Data Licence) by scripts/resourceLtaRates.ts.
 *
 * Running this again would have re-scraped and overwritten that licensed data,
 * so the scraper is gone rather than merely disused. If LTA grants written
 * permission one day, the scraping logic is in git history before this commit.
 *
 *   npm run resource-lta        # the replacement: licensed, same car parks
 */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * The "Last updated 16 April 2026" line in a OneMotoring footer, as
 * YYYY-MM-DD. Kept because it dates content correctly for ANY page that
 * publishes such a line, and migration v5's correction of the old rows is
 * documented against it. Returns null rather than guessing, so a footer that
 * changes shape yields no date instead of silently claiming today.
 */
export function lastUpdatedFrom(html: string): string | null {
  const m = html
    .replace(/<[^>]+>/g, " ")
    .match(/last\s+updated\s*:?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

if (process.argv[1] && process.argv[1].endsWith("importLta.ts")) {
  console.error(
    "import-lta is retired: scraping OneMotoring violates its Terms of Use,\n" +
      "and re-running it would overwrite the licensed rows from the open dataset.\n" +
      "Use `npm run resource-lta` instead — same car parks, Singapore Open Data Licence.",
  );
  process.exit(1);
}
