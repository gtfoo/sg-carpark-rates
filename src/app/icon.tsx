import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { resolveBrand } from "@/lib/brand-config";

/**
 * Home-screen / tab icon. Coloured from the request hostname so each brand
 * gets its own glyph. Next serves this at /icon, which the manifest references.
 */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default async function Icon() {
  const brand = resolveBrand((await headers()).get("host"));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: brand.palettes.dark.bg,
          color: brand.palettes.dark.accent,
          fontSize: 300,
          fontWeight: 700,
          letterSpacing: -10,
        }}
      >
        P
      </div>
    ),
    size,
  );
}
