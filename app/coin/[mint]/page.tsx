"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TokenDetail } from "@/components/token-detail";
import { Skeleton } from "@/components/ui/skeleton";
import type { Candidate, Role } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";

/**
 * Full coin detail page: /coin/[mint]
 * Same TokenDetail as the drawer, but as a dedicated page with
 * back navigation and full viewport.
 */
export default function CoinPage() {
  const params = useParams();
  const router = useRouter();
  const mint = decodeURIComponent(params.mint as string);

  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [enriched, setEnriched] = useState<EnrichedToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [watched, setWatched] = useState(false);
  const role: Role = "dip"; // dashboard passes real role; page defaults to dip view

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Find the candidate in the state feed
        const res = await fetch("/api/state");
        const d = await res.json();
        const c = (d.candidates ?? []).find(
          (x: Candidate) => x.mint === mint
        );
        if (!cancelled) {
          setCandidate(c ?? null);
          // TODO: fetch enriched data for mint
        }
      } catch {
        /* keep null */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [mint]);

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!candidate) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <button
          onClick={() => router.back()}
          className="mb-4 font-mono text-[13px] text-gold hover:underline"
        >
          ← back
        </button>
        <p className="font-mono text-[14px] text-mut">
          Coin not found. It may have dropped from the candidate feed.
        </p>
        <p className="mt-2 break-all font-mono text-[11px] text-mut/60">{mint}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-4 pb-24">
      <button
        onClick={() => router.back()}
        className="mb-4 font-mono text-[13px] text-gold hover:underline"
      >
        ← back
      </button>
      <TokenDetail
        candidate={candidate}
        enriched={enriched}
        role={role}
        watched={watched}
        onToggleWatch={() => setWatched((w) => !w)}
        onExecute={() => {}}
      />
    </div>
  );
}
