import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { resolveBrand } from "@/lib/brand-config";

/**
 * Makes the app installable to the home screen on both Android and iOS.
 *
 * `display: standalone` is what removes the browser chrome so it launches
 * like a native app. Installation requires HTTPS in production — it will not
 * be offered over plain HTTP on your VPS.
 *
 * The name, label and colours follow the request hostname, so each brand
 * installs to the home screen under its own identity from the shared app.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const brand = resolveBrand((await headers()).get("host"));
  // A brand that ships its own artwork installs with it; one that doesn't gets
  // the generated glyph at /icon. Same shape either way, so the manifest needs
  // no knowledge of which brands have artwork.
  const src = brand.icon ? "/brand/icon" : "/icon";
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: brand.description,
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: brand.palettes.dark.bg,
    theme_color: brand.palettes.dark.bg,
    icons: [
      { src, sizes: "512x512", type: "image/png", purpose: "any" },
      { src, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
