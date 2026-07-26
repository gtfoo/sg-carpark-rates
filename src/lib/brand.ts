export type BrandKey = "carpark" | "anne";

export interface Brand {
  key: BrandKey;
  name: string;
  /** Home-screen label — keep short so iOS/Android don't truncate it. */
  shortName: string;
  description: string;
  tagline: string;
  /**
   * Colours the manifest and generated icons need. These mirror the dark
   * palette in globals.css (which the runtime CSS can't be read from here),
   * so keep the two in sync when tweaking a brand's look.
   */
  theme: { bg: string; accent: string };
}

const brands: Record<BrandKey, Brand> = {
  carpark: {
    key: "carpark",
    name: "Carpark SG",
    shortName: "Carpark",
    description: "Nearby Singapore carparks, rates and availability",
    tagline: "Nearby carparks, rates and live availability",
    theme: { bg: "#0b0d10", accent: "#5b8cff" },
  },
  anne: {
    key: "anne",
    name: "Park Here Anne",
    shortName: "Park Anne",
    description: "A friendly way to find nearby Singapore carparks, rates and availability",
    tagline: "A friendly way to find your next parking spot",
    theme: { bg: "#181016", accent: "#e76d9b" },
  },
};

/** Select the visual identity from the public hostname. All parking logic is shared. */
export function brandFromHost(host: string | null): Brand {
  const hostname = (host?.split(":")[0] ?? "").toLowerCase();
  return hostname === "park-here-anne.gtfoo.com" ? brands.anne : brands.carpark;
}