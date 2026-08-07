import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray package-lock.json in ~ makes Turbopack infer the wrong workspace
  // root, which breaks file tracing into the standalone build.
  //
  // Do NOT compute this from import.meta.url — this package is not
  // "type": "module", so the config is loaded as CJS and that resolves to the
  // wrong path, which makes Turbopack miss src/app entirely and 404 every
  // route. process.cwd() is where next is invoked from, i.e. the project root.
  turbopack: {
    root: process.cwd(),
  },
  // Emits a self-contained server bundle in .next/standalone, so the VPS only
  // needs Node — no npm install of the full dependency tree on the box.
  output: "standalone",
  // better-sqlite3 is a native (.node) addon — it must not be bundled, or the
  // build fails trying to parse the binary. Keep it external so it's required
  // from node_modules at runtime; standalone output traces the .node file in.
  serverExternalPackages: ["better-sqlite3"],
  // File tracing copies the live SQLite database into
  // .next/standalone/data/carpark.db. That snapshot is stale the moment it's
  // taken, and if this app is ever run from the standalone server (as the
  // sibling apps on the droplet are) it would read and WRITE that copy instead
  // of the real database — losing every saved rate. The DB is runtime state,
  // never a build input, so keep the whole directory out of the trace.
  outputFileTracingExcludes: {
    "/*": ["data/**"],
  },
};

export default nextConfig;
