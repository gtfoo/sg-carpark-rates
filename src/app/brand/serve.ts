/**
 * Serves brand artwork that lives outside the repository.
 *
 * The files cannot sit in `public/`: that is inside the app tree, so a deploy
 * (and, later, a `rsync --delete` release swap) can remove them. They live
 * beside the repo and are streamed from here instead.
 *
 * There is no user-controlled path anywhere in this. The filename comes from
 * the brand config, which is validated to be a bare basename, and the brand
 * itself comes from the request's Host header — so a request can choose which
 * brand's asset it gets, but never which file on disk.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { headers } from "next/headers";
import { brandAssetPath, resolveBrand } from "@/lib/brand-config";

const CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

export async function serveBrandAsset(which: "logo" | "icon"): Promise<Response> {
  const brand = resolveBrand((await headers()).get("host"));
  const file = brandAssetPath(brand, which);
  if (!file) return new Response("no such asset", { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    // A brand naming artwork that isn't on disk is a misconfiguration, not a
    // request error — log it, because the page will fall back to the wordmark
    // and otherwise look merely unstyled.
    console.error(`[brand] ${brand.key}.${which} points at a missing file: ${file}`);
    return new Response("no such asset", { status: 404 });
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPE[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      // Private skins are small and change roughly never, but a stale logo
      // after a swap is confusing — an hour is long enough to be free and
      // short enough to fix itself.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
