import type { MetadataRoute } from "next";

/**
 * Makes the app installable to the home screen on both Android and iOS.
 *
 * `display: standalone` is what removes the browser chrome so it launches
 * like a native app. Installation requires HTTPS in production — it will not
 * be offered over plain HTTP on your VPS.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Carpark SG",
    short_name: "Carpark",
    description: "Nearby Singapore carparks, rates and availability",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0d10",
    theme_color: "#0b0d10",
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
