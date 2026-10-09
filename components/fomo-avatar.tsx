"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * TraderAvatar — FOMO trader profile image with a deterministic identicon
 * fallback. When the FOMO API has no avatar for a trader, we generate a
 * GitHub-style 5x5 mirrored identicon from the handle hash so every row
 * still gets a unique, recognizable image instead of a blank letter.
 */

const IDENTICON_COLORS = [
  "#e7b84b", // gold
  "#72a9c9",
  "#55d187",
  "#b48be0",
  "#e08b9a",
  "#8bd1c9",
  "#d1c48b",
  "#9a8be0",
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 5x5 mirrored identicon as an SVG data URI, deterministic per seed. */
export function identiconDataUri(seed: string): string {
  const h = hashStr(seed || "?");
  const color = IDENTICON_COLORS[h % IDENTICON_COLORS.length];
  const cells: string[] = [];
  let bits = h;
  // 15 bits drive the left 3 columns (mirrored to 5).
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const on = (bits & 1) === 1;
      bits >>>= 1;
      if (bits === 0) bits = hashStr(seed + row + ":" + col) >>> 0 || 1;
      if (on) {
        const x0 = col * 20;
        const x1 = (4 - col) * 20;
        cells.push(
          `<rect x="${x0}" y="${row * 20}" width="20" height="20" fill="${color}"/>`
        );
        if (x1 !== x0)
          cells.push(
            `<rect x="${x1}" y="${row * 20}" width="20" height="20" fill="${color}"/>`
          );
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1a1f26"/>${cells.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function TraderAvatar({
  handle,
  avatar,
  size = 40,
  className,
}: {
  handle: string;
  avatar: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const fallback = useMemo(() => identiconDataUri(handle), [handle]);
  const src = avatar || fallback;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={cn("shrink-0 rounded-full object-cover", className)}
      style={{ width: size, height: size }}
      // If the upstream avatar 404s, fall back to the identicon.
      onError={(e) => {
        const el = e.currentTarget;
        if (el.src !== fallback) el.src = fallback;
      }}
    />
  );
}
