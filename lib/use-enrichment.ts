"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chunk,
  emptyEnriched,
  fetchBatch,
  mergePairs,
  type EnrichedToken,
} from "@/lib/dexscreener";

const BATCH_SIZE = 30;

export type EnrichStatus = "idle" | "loading" | "ready" | "error";

export interface Enrichment {
  byMint: Record<string, EnrichedToken>;
  status: EnrichStatus;
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Client-side batched enrichment against the DexScreener free API.
 * Runs when the mint list changes; mints absent from DexScreener are
 * marked with an empty placeholder so the UI can say so honestly.
 */
export function useEnrichment(mints: string[]): Enrichment {
  const [byMint, setByMint] = useState<Record<string, EnrichedToken>>({});
  const [status, setStatus] = useState<EnrichStatus>("idle");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const runId = useRef(0);
  const key = Array.from(new Set(mints.filter(Boolean))).sort().join(",");

  const run = useCallback(async () => {
    const list = key.split(",").filter(Boolean);
    if (list.length === 0) {
      setByMint({});
      setStatus("idle");
      return;
    }
    const my = ++runId.current;
    setStatus((s) => (s === "idle" ? "loading" : s));

    async function viaServer(batch: string[]): Promise<EnrichedToken[]> {
      const res = await fetch(`/api/enrich?mints=${batch.join(",")}`);
      if (!res.ok) throw new Error(`enrich ${res.status}`);
      const data = await res.json();
      if (!data?.ok) throw new Error("enrich failed");
      return Object.values(data.tokens ?? {}) as EnrichedToken[];
    }

    try {
      const batches = chunk(list, BATCH_SIZE);
      // Primary: direct client-side fetch to the DexScreener free API.
      // Fallback: our own server-side route when the direct path is blocked
      // (TLS-intercepting proxies, adblockers, DNS weirdness).
      const results = await Promise.all(
        batches.map(async (batch) => {
          try {
            const pairs = await fetchBatch(batch);
            const merged = mergePairs(pairs);
            return batch.map((m) => merged[m] ?? emptyEnriched(m));
          } catch {
            return viaServer(batch);
          }
        })
      );
      if (runId.current !== my) return; // superseded
      const out: Record<string, EnrichedToken> = {};
      for (const t of results.flat()) out[t.mint] = t;
      setByMint(out);
      setStatus("ready");
      setUpdatedAt(Math.floor(Date.now() / 1000));
    } catch {
      if (runId.current !== my) return;
      setStatus("error");
    }
  }, [key]);

  useEffect(() => {
    run();
  }, [run]);

  return { byMint, status, updatedAt, refresh: run };
}
