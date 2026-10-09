"use client";

import { useEffect, useMemo, useState } from "react";
import type { LifecycleInfo } from "@/lib/lifecycle";

export type LifeMap = Record<string, LifecycleInfo>;

/**
 * Shared token-lifecycle hook (extracted from Trenches).
 * Fetches /api/lifecycle for up to 60 mints, keyed on the mint set.
 * Components that need the same data should share one hook instance
 * via props rather than calling this twice.
 */
export function useLifecycle(mints: string[]): LifeMap {
  const [map, setMap] = useState<LifeMap>({});
  const key = useMemo(
    () => Array.from(new Set(mints.filter(Boolean))).sort().join(","),
    [mints]
  );
  useEffect(() => {
    const list = key.split(",").filter(Boolean).slice(0, 60);
    if (list.length === 0) {
      setMap({});
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/lifecycle?mints=${encodeURIComponent(list.join(","))}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, LifecycleInfo>;
        if (alive) setMap(data ?? {});
      } catch {
        /* lifecycle unknown; columns fall back gracefully */
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);
  return map;
}
