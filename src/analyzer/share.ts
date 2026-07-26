/** Compact, shareable code for a Waystone's raw item text — paste into
 *  Discord, decode on another instance to see the same analysis. The code
 *  carries the original item text (gzip + base64url), not a separately
 *  serialized score: decoding just re-runs the normal analyzeWaystoneText
 *  pipeline, so a shared code can never drift from scoring.ts. Zero server
 *  involved — everything happens in the two overlays' webviews. */

const PREFIX = "WA1:";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encodeWaystoneShare(itemText: string): Promise<string> {
  const stream = new Blob([itemText]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return PREFIX + bytesToBase64Url(bytes);
}

export async function decodeWaystoneShare(code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const bytes = base64UrlToBytes(trimmed.slice(PREFIX.length));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}
