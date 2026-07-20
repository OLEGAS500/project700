import { ImageResponse } from "next/og";

export const alt = "EIM Catalog Monitor test item";
export const contentType = "image/png";
export const runtime = "edge";
export const size = {
  width: 1000,
  height: 1000
};

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#edf6f0",
          color: "#174930",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
          padding: 96,
          width: "100%"
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "#256f4c",
            borderRadius: 48,
            color: "white",
            display: "flex",
            fontSize: 88,
            fontWeight: 800,
            height: 248,
            justifyContent: "center",
            letterSpacing: 12,
            width: 248
          }}
        >
          EIM
        </div>
        <div style={{ fontSize: 64, fontWeight: 800, marginTop: 58, textAlign: "center" }}>
          Catalog Monitor
        </div>
        <div style={{ fontSize: 36, marginTop: 22, textAlign: "center" }}>
          Staging test item — not for purchase
        </div>
      </div>
    ),
    size
  );
}
