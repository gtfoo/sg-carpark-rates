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
  // NOT output: "standalone". The droplet serves this with `next start` (see
  // the systemd unit and scripts/deploy.sh), and Next 16 rejects that pairing:
  //   ⚠ "next start" does not work with "output: standalone" configuration
  // The standalone bundle was being built on every deploy and never served —
  // wasted minutes on a 1 vCPU box. npm ci already puts the full dependency
  // tree on the server, which better-sqlite3 needs anyway.
  //
  // If you ever do switch to `node .next/standalone/server.js`, add it back
  // AND keep the tracing exclude below.

  // better-sqlite3 is a native (.node) addon — it must not be bundled, or the
  // build fails trying to parse the binary. Keep it external so it's required
  // from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // The live SQLite database is runtime state, never a build input. File
  // tracing used to copy it into the build output, where a standalone server
  // would have read and WRITTEN the stale copy instead of the real database,
  // losing every saved rate. Harmless now that standalone is off, kept so it
  // can't come back if standalone is ever re-enabled.
  outputFileTracingExcludes: {
    "/*": ["data/**"],
  },
};

export default nextConfig;
