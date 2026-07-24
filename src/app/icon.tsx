import { ImageResponse } from "next/og";

/**
 * Generated at build time so there are no binary assets to manage.
 * Next serves this at /icon, which the manifest references.
 */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
