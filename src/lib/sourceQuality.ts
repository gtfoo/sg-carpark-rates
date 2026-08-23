/**
 * Whether a URL is a publication we should be willing to cite for a price.
 *
 * Singapore Botanic Gardens was stored against a personal WordPress blog. The
 * URL resolved, the page existed, and the location was right — so every guard
 * we have passed it. What was wrong is unfixable by fetching: a blog carries no
 * revision date, answers to nobody, and may have been copied from a sign years
 * ago. The stored rate was also self-contradictory ("$0.02 per minute (7:00 AM
 * - 10:30 PM); $1 (8:00 AM - 9:00 AM)" — overlapping bands), which is what an
 * unmaintained source looks like from the outside.
 *
 * This is deliberately a list of PLATFORMS, not of sites. Judging individual
 * domains would mean maintaining an opinion about every carpark aggregator in
 * Singapore, and getting it wrong quietly. Free publishing and user-generated
 * platforms are a structural signal: anyone can put anything there, and nothing
 * about the host implies an operator stands behind the number.
 *
 * Free app-hosting subdomains are included for the same reason — `*.vercel.app`
 * is someone's side project until proven otherwise. Note this is a real
 * trade-off and not a free win: `parking-go-where.vercel.app` was the citation
 * on a MOE rate that is, as far as we can tell, correct. That rate survives
 * because other sources carried it too, which is exactly the distinction being
 * drawn — low trust demotes a citation, and only refuses a save when there is
 * nothing better anywhere in the results.
 */
const LOW_TRUST_HOSTS = [
  // Free publishing — no editorial process, no revision date.
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
  // User-generated / discussion.
  "reddit.com",
  "facebook.com",
  "quora.com",
  "tripadvisor.com",
  "tripadvisor.com.sg",
  "hardwarezone.com.sg",
  // Free app hosting — a side project until shown otherwise.
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

export function isLowTrustSource(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  return LOW_TRUST_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/**
 * Sources worth citing, in order, with low-trust ones removed.
 *
 * Returns an empty array when everything found was low-trust — which the caller
 * must treat as "no usable source", not as "cite the first one anyway".
 */
export function trustworthySources(urls: string[]): string[] {
  return urls.filter((u) => u && !isLowTrustSource(u));
}
