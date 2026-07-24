import { ImageResponse } from "next/og";

/** iOS uses this for the home-screen icon after "Add to Home Screen". */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0d10",
          color: "#5b8cff",
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
