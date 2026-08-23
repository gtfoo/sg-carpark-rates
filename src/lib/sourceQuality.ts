/**
 * How much a URL is worth as the citation on a price.
 *
 * Two properties get confused here, and keeping them apart is the whole point:
 *
 *   EVIDENCE  does this page actually state the rate?
 *   TRUST     is whoever published it accountable for it?
 *
 * A citation needs both, and trust alone is worthless. Proven the hard way:
 * MOE (Evans Road) was re-cited from a free-hosting carpark directory to
 * streetdirectory.com because the latter is the more reputable host — and
 * streetdirectory's page carries no dollar amount anywhere in 86 KB of HTML,
 * while the one it replaced states "$1.20", "Parking Rates" and "Grace
 * period". The upgrade made the citation strictly worse: a reader following it
 * finds nothing, and nothing about the rate was ever verified.
 *
 * Trust is also not one thing. A personal WordPress travel post and a
 * structured carpark directory on a `.vercel.app` subdomain are both
 * "self-published" and are not the same risk, so they get different tiers:
 *
 *   blocked  personal blogs, forums, user-generated pages. Never cite. If
 *            these are the ONLY results, refuse the save — Singapore Botanic
 *            Gardens came from a WordPress post and its rate was internally
 *            contradictory, which is what an unmaintained source looks like.
 *   weak     free app hosting. Someone's side project, but often a real
 *            directory. Cite it when nothing better states the rate.
 *   ok       everything else: operators, aggregators, government.
 */
export type SourceTier = "ok" | "weak" | "blocked";

/** Self-published opinion. Never a price authority. */
const BLOCKED_HOSTS = [
  "wordpress.com",
  "blogspot.com",
  "blogspot.sg",
  "medium.com",
  "wixsite.com",
  "weebly.com",
  "substack.com",
  "tumblr.com",
  "livejournal.com",
  "blogger.com",
  "reddit.com",
  "facebook.com",
  "quora.com",
  "tripadvisor.com",
  "tripadvisor.com.sg",
  "hardwarezone.com.sg",
];

/** Free hosting: unaccountable, but frequently a genuine directory. */
const WEAK_HOSTS = [
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "github.io",
  "herokuapp.com",
  "glitch.me",
  "replit.app",
];

/** Host, lowercased, without a leading `www.`; empty string if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const matches = (host: string, list: string[]) =>
  list.some((bad) => host === bad || host.endsWith(`.${bad}`));

export function sourceTier(url: string | null | undefined): SourceTier {
  if (!url) return "ok";
  const host = hostOf(url);
  if (!host) return "ok";
  if (matches(host, BLOCKED_HOSTS)) return "blocked";
  if (matches(host, WEAK_HOSTS)) return "weak";
  return "ok";
}

/** A page that quotes money is evidence; one that does not is a pointer. */
export function statesAPrice(content: string | null | undefined): boolean {
  return Boolean(content && /\$\s?\d/.test(content));
}

export interface Citable {
  url: string;
  content?: string | null;
}

/**
 * Best citation first: evidence outranks reputation, reputation breaks ties.
 *
 * `blocked` hosts are dropped entirely rather than sorted last — citing one is
 * never the right answer, and leaving them in the list would let a save
 * proceed on nothing but a blog.
 */
export function rankCitations(hits: Citable[]): string[] {
  const scored = hits
    .filter((h) => h.url && sourceTier(h.url) !== "blocked")
    .map((h, i) => ({
      url: h.url,
      i,
      // 0 is best. Stating the price dominates; tier only orders within that.
      rank: (statesAPrice(h.content) ? 0 : 2) + (sourceTier(h.url) === "weak" ? 1 : 0),
    }));
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return scored.map((s) => s.url);
}

/** True when every result was a blog, forum or other self-published page. */
export function allBlocked(hits: Citable[]): boolean {
  return hits.length > 0 && hits.every((h) => sourceTier(h.url) === "blocked");
}
