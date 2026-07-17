import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Ecommerce Incident Monitor",
  description: "Revenue incident monitoring for ecommerce stores and agencies.",
  verification: {
    google: "5z2X6PdxJd7qhs-uyXZNj_-M3uGY4CSqXCFX8ffqi3g"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
