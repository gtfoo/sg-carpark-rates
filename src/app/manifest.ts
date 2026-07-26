import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { brandFromHost } from "@/lib/brand";

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
  const brand = brandFromHost((await headers()).get("host"));
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: brand.description,
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: brand.theme.bg,
    theme_color: brand.theme.bg,
    icons: [
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
