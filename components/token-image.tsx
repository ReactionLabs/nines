"use client";

import { useState } from "react";

/**
 * Normalize a token image URL into something loadable.
 *
 * Handles the broken shapes the scanner has stored:
 * - Helius CDN proxy wrapper: https://cdn.helius-rpc.com/cdn-cgi/image//{src}
 *   (the proxy 403s; unwrap to the source URL)
 * - ipfs:// protocol -> Pinata gateway (ipfs.io 403s from most clients)
 * - ipfs.io gateway -> Pinata gateway (more reliable)
 * - Garbage (Google Lens upload URLs etc.) -> null
 */
export function normalizeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.trim();
  if (!u) return null;

  // Unwrap Helius image CDN proxy
  const marker = "cdn.helius-rpc.com/cdn-cgi/image//";
  const idx = u.indexOf(marker);
  if (idx >= 0) {
    u = u.slice(idx + marker.length);
  }

  // ipfs:// -> gateway
  if (u.startsWith("ipfs://")) {
    u = "https://gateway.pinata.cloud/ipfs/" + u.slice(7);
  }
  // ipfs.io is flaky/403s -> Pinata
  if (u.startsWith("https://ipfs.io/ipfs/")) {
    u = "https://gateway.pinata.cloud/ipfs/" + u.slice("https://ipfs.io/ipfs/".length);
  }

  // Reject known-garbage shapes
  if (u.includes("lens.google.com/uploadbyurl")) return null;
  if (!/^https:\/\//i.test(u)) return null;

  return u;
}

/**
 * Token icon, Axiom-style: square with rounded corners, not a circle.
 *
 * Cascade: scanner-resolved on-chain image (candidate.image_url) ->
 * DexScreener enrichment (imageUrl) -> letter tile. Never renders a
 * broken-image icon: any load error swaps to the letter fallback.
 * Images lazy-load so the feed renders instantly.
 */
export function TokenIcon({
  src,
  symbol,
  size = "md",
}: {
  src: string | null | undefined;
  symbol: string | null | undefined;
  size?: "sm" | "md" | "lg";
}) {
  const [err, setErr] = useState(false);
  const dims =
    size === "sm"
      ? "h-6 w-6 text-[9px] rounded-md"
      : size === "lg"
        ? "h-12 w-12 text-sm rounded-xl"
        : "h-10 w-10 text-[11px] rounded-lg";
  const letter = (symbol ?? "?").slice(0, 1).toUpperCase();
  const url = !err ? normalizeImageUrl(src) : null;

  if (!url) {
    return (
      <span
        className={`flex ${dims} shrink-0 items-center justify-center border border-line bg-white/5 font-mono text-mut`}
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setErr(true)}
      className={`${dims} shrink-0 border border-line object-cover`}
    />
  );
}
