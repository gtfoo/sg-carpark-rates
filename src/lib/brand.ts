export type BrandKey = "carpark";

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
};

/** Select the visual identity from the public hostname. */
export function brandFromHost(host: string | null): Brand {
  void host;
  return brands.carpark;
}
