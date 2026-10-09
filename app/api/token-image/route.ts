import { resolveTokenImages } from "@/lib/token-image-resolve";

/**
 * Server-side token image resolution.
 *
 * GET /api/token-image?mints=<m1,m2,...>  (<=30 mints)
 * -> { ok: true, images: { <mint>: <imageUrl | null> } }
 *
 * The feed renders immediately with the letter fallback and swaps in
 * logos as they resolve client-side (see lib/use-token-images.ts), so
 * this route never blocks a render. Resolution is cached aggressively
 * server-side (hits 24h, misses 6h).
 *
 * Session-gated by middleware like every other /api/* route.
 */
export const dynamic = "force-dynamic";

const MAX_MINTS = 30;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get("mints") ?? "").split(",").filter(Boolean);
  const mints = Array.from(new Set(raw)).slice(0, MAX_MINTS);

  if (mints.length === 0) {
    return Response.json({ ok: false, reason: "mints required" }, { status: 400 });
  }
  if (!mints.every((m) => MINT_RE.test(m))) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }

  try {
    const images = await resolveTokenImages(mints);
    return Response.json(
      { ok: true, images },
      { headers: { "Cache-Control": "public, max-age=3600" } }
    );
  } catch {
    return Response.json(
      { ok: false, reason: "resolution failed" },
      { status: 502 }
    );
  }
}
