"use client";

import { useEffect, useMemo, useState } from "react";
import type { IntelBase, IntelDetail } from "@/lib/holder-intel";

const BATCH_MAX = 10;

/**
 * Batch compact holder intel for feed cards. One request per distinct mint
 * set (deduped, capped at BATCH_MAX mints); results keyed by mint.
 */
export function useHolderIntel(mints: string[]): {
  byMint: Record<string, IntelBase>;
  loading: boolean;
} {
  const key = useMemo(
    () => Array.from(new Set(mints.filter(Boolean))).sort().join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mints.join(",")]
  );
  const [byMint, setByMint] = useState<Record<string, IntelBase>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!key) {
      setByMint({});
      setLoading(false);
      return;
    }
    const list = key.split(",").slice(0, BATCH_MAX);
    let cancelled = false;
    setLoading(true);
    fetch(`/api/token-holder-intel?mints=${encodeURIComponent(list.join(","))}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.ok) setByMint(d.tokens ?? {});
      })
      .catch(() => {
        /* intel is best-effort; cards render without it */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { byMint, loading };
}

/**
 * Full detail intel for the token drawer. Fetches when a mint is selected;
 * the expensive sections (sniper scan, honeypot simulation) only run here.
 */
export function useHolderIntelDetail(mint: string | null): {
  detail: IntelDetail | null;
  loading: boolean;
} {
  const [detail, setDetail] = useState<IntelDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!mint) {
      setDetail(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/token-holder-intel?mint=${encodeURIComponent(mint)}&detail=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.ok) setDetail(d.tokens?.[mint] ?? null);
      })
      .catch(() => {
        /* drawer renders without intel on failure */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mint]);

  return { detail, loading };
}
