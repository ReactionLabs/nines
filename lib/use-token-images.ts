"use client";

import { useEffect, useMemo, useState } from "react";

const BATCH_SIZE = 30;

/**
 * Module-level client cache: mint -> image URL (null = resolved, none).
 * Shared across hook instances so scrolling the feed never refetches.
 */
const clientCache = new Map<string, string | null>();

/**
 * Resolve token logos for a list of mints without blocking render.
 *
 * Rows render immediately with the letter fallback (TokenIcon shows
 * nothing until `src` is set); when a batch resolves, the hook
 * re-renders and the logo swaps into the same fixed-size slot, so
 * there is no layout shift. Unresolved mints stay letters forever.
 * Server-side results are cached aggressively; negatives are cached
 * too, so this never spams the API.
 */
export function useTokenImages(mints: string[]): {
  images: Record<string, string | null>;
} {
  const [tick, setTick] = useState(0);
  const key = useMemo(
    () => Array.from(new Set(mints.filter(Boolean))).sort().join(","),
    [mints]
  );

  useEffect(() => {
    const list = key.split(",").filter(Boolean);
    const missing = list.filter((m) => !clientCache.has(m));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        try {
          const res = await fetch(
            `/api/token-image?mints=${batch.map(encodeURIComponent).join(",")}`
          );
          const data = await res.json();
          if (data?.ok && data.images) {
            for (const m of batch) {
              const v = (data.images as Record<string, unknown>)[m];
              clientCache.set(m, typeof v === "string" ? v : null);
            }
          }
          // Non-ok: leave uncached; the letter fallback stands.
        } catch {
          // Network failure: leave uncached, letter fallback stands.
        }
        if (!cancelled) setTick((t) => t + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const images = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const m of key.split(",").filter(Boolean)) {
      if (clientCache.has(m)) out[m] = clientCache.get(m) ?? null;
    }
    return out;
  }, [key, tick]);

  return { images };
}
