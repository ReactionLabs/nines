"use client";

import type { Candidate } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import { fmtCompactUsd, gateScore, shortMint, timeAgo } from "@/lib/format";
import { TokenIcon } from "@/components/token-image";
import { WatchStar } from "@/components/watch-star";

/**
 * The Nines watch: only coins that cleared all nine gates.
 * This is the curated list, separate from the raw trenches feed.
 */
export function NinesWatch({
  candidates,
  byMint,
  onSelect,
  watchedMints,
  onToggleWatch,
}: {
  candidates: Candidate[];
  byMint: Record<string, EnrichedToken>;
  onSelect: (c: Candidate) => void;
  watchedMints: Set<string>;
  onToggleWatch: (c: Candidate) => void;
}) {
  const cleared = candidates
    .filter((c) => {
      const s = gateScore(c.gates);
      return s.total >= 9 && s.passed === s.total;
    })
    .sort((a, b) => (b.alerted_at ?? b.first_seen ?? 0) - (a.alerted_at ?? a.first_seen ?? 0));

  if (cleared.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-10 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gold/10 font-mono text-xl font-bold text-gold">
          9
        </div>
        <p className="text-[14px] font-semibold text-white">
          No coins have cleared the Nines yet
        </p>
        <p className="mt-1 font-mono text-[11px] text-mut">
          When a coin passes all nine gates, it lands here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {cleared.map((c) => {
        const e = byMint[c.mint];
        const name = e?.name || e?.symbol || shortMint(c.mint);
        return (
          <button
            key={c.mint}
            onClick={() => onSelect(c)}
            className="flex w-full items-center gap-3 rounded-lg border border-gold/25 bg-surface p-3 text-left transition-colors hover:border-gold/50 hover:bg-raised"
          >
            <TokenIcon
              src={c.image_url || e?.imageUrl || undefined}
              symbol={e?.symbol ?? name}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-white">
                {e?.symbol && (
                  <span className="mr-1 font-mono text-up">{e.symbol}</span>
                )}
                {name}
              </div>
              <div className="font-mono text-[10px] text-mut">
                {shortMint(c.mint)} · {timeAgo(c.first_seen)}
              </div>
            </div>
            <div className="shrink-0 text-right font-mono text-[11px] text-mut">
              <div>
                MC <span className="text-white">{fmtCompactUsd(e?.mcapUsd)}</span>
              </div>
              <div>
                V <span className="text-white">{fmtCompactUsd(c.volume_usd ?? e?.vol24h)}</span>
              </div>
            </div>
            <div className="shrink-0 rounded bg-up/15 px-2 py-1 font-mono text-[11px] font-bold text-up">
              9/9
            </div>
            <WatchStar
              watched={watchedMints.has(c.mint)}
              onToggle={() => onToggleWatch(c)}
              size="sm"
            />
          </button>
        );
      })}
    </div>
  );
}
