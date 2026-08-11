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
    // Tints the mobile browser chrome. Two entries so it tracks the system
    // setting; ThemeToggle rewrites the tag directly when a user overrides it,
    // since a media query can't know about that choice.
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
      { media: "(prefers-color-scheme: dark)", color: brand.theme.bg },
    ],
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
      <head>
        {/*
          Applies a stored theme BEFORE first paint. Without this the page
          renders in the system theme and then snaps to the chosen one — the
          flash is worst for a user who picked light on a dark-mode phone,
          which is exactly the person who bothered to set it.

          Deliberately not a React effect: those run after paint, which is too
          late. Wrapped in try/catch because localStorage throws outright in
          Safari private browsing rather than returning null.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('carpark:theme');" +
              "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
      </head>
      <body data-brand={brand.key}>
        <BrandProvider brand={brand}>{children}</BrandProvider>
      </body>
    </html>
  );
}
