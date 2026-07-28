import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { BrandProvider } from "./brand-provider";
import { brandFromHost } from "@/lib/brand";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const brand = brandFromHost((await headers()).get("host"));
  return {
    title: brand.name,
    description: brand.description,
    appleWebApp: {
      capable: true,
      title: brand.name,
      statusBarStyle: "black-translucent",
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const brand = brandFromHost((await headers()).get("host"));
  return {
    // Tints the mobile browser chrome to match the brand.
    themeColor: brand.theme.bg,
    width: "device-width",
    initialScale: 1,
    // Allow pinch-zoom; disabling it is an accessibility failure.
    maximumScale: 5,
    viewportFit: "cover",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const brand = brandFromHost((await headers()).get("host"));
  return (
    <html lang="en">
      <body data-brand={brand.key}>
        <BrandProvider brand={brand}>{children}</BrandProvider>
      </body>
    </html>
  );
}
