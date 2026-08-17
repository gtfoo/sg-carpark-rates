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
import { readFile, stat } from "node:fs/promises";
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
  const h = await headers();
  const brand = resolveBrand(h.get("host"));
  const file = brandAssetPath(brand, which);
  if (!file) return new Response("no such asset", { status: 404 });

  // Revalidation, so max-age can stay short without costing a re-download.
  //
  // These are brand renders, not display assets — one is 1.6 MB. With
  // max-age alone a returning visitor re-fetched all of it every hour, and
  // over a slow phone connection that is a 30-second transfer for an image
  // that has not changed since July.
  //
  // Built from size and mtime rather than a content hash: hashing 1.6 MB on
  // every request to save sending it is the wrong trade, and the file only
  // changes when someone swaps it on the server, which moves both.
  let tag: string | null = null;
  try {
    const s = await stat(file);
    tag = `W/"${s.size.toString(16)}-${Math.trunc(s.mtimeMs).toString(16)}"`;
  } catch {
    // Fall through to the read below, which reports the missing file properly.
  }

  if (tag && h.get("if-none-match") === tag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: tag, "Cache-Control": "public, max-age=3600" },
    });
  }

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
      // An hour is long enough to be free and short enough that a swapped
      // logo fixes itself. The ETag above is what makes that cheap: after the
      // hour the browser asks, and gets 304 with no body unless it changed.
      "Cache-Control": "public, max-age=3600",
      ...(tag ? { ETag: tag } : {}),
    },
  });
}
