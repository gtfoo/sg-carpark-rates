import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { brandFromHost } from "@/lib/brand";

/**
 * Home-screen / tab icon. Coloured from the request hostname so each brand
 * gets its own glyph. Next serves this at /icon, which the manifest references.
 */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default async function Icon() {
  const brand = brandFromHost((await headers()).get("host"));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: brand.theme.bg,
          color: brand.theme.accent,
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
