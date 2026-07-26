import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { brandFromHost } from "@/lib/brand";

/** iOS uses this for the home-screen icon after "Add to Home Screen". */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
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
