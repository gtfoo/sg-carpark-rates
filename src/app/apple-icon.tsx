import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { resolveBrand } from "@/lib/brand-config";

/** iOS uses this for the home-screen icon after "Add to Home Screen". */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
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
          fontSize: 110,
          fontWeight: 700,
        }}
      >
        P
      </div>
    ),
    size,
  );
}
