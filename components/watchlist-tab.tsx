"use client";

import { Badge } from "@/components/ui/badge";
import { TokenIcon } from "@/components/token-image";
import type { Candidate } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import type { WatchlistEntry } from "@/lib/watchlist";
import {
  fmtCompactUsd,
  fmtPct,
  fmtPrice,
  fmtSignedUsd,
  fmtTimeET,
  gateScore,
  shortMint,
  timeAgo,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Personal watchlist: coins Dip starred while scanning, checked back on
 * later. The since-added performance is the whole point of this view.
 */
export function WatchlistTab({
  entries,
  byMint,
  candidatesByMint,
  onSelectMint,
  onRemove,
}: {
  entries: WatchlistEntry[];
  byMint: Record<string, EnrichedToken>;
  candidatesByMint: Record<string, Candidate>;
  onSelectMint: (mint: string) => void;
  onRemove: (mint: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line p-10 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gold/10">
          <svg
            className="h-6 w-6 text-gold"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          >
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </div>
        <p className="text-[14px] font-semibold text-white">
          No coins on your watchlist yet
        </p>
        <p className="mt-1 font-mono text-[11px] text-mut">
          Tap the star on any coin while scanning. Check back tomorrow to see
          where they&apos;re at.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="px-1 font-mono text-[11px] text-mut/70">
        {entries.length} saved · performance measured from the price when you
        starred it
      </p>
      {entries.map((w) => {
        const e = byMint[w.mint];
        const live = e?.priceUsd ?? null;
        const sinceUsd =
          live !== null && w.priceAtAdd !== null ? live - w.priceAtAdd : null;
        const sincePct =
          live !== null && w.priceAtAdd !== null && w.priceAtAdd > 0
            ? ((live - w.priceAtAdd) / w.priceAtAdd) * 100
            : null;
        const up = sincePct !== null && sincePct > 0;
        const down = sincePct !== null && sincePct < 0;
        const cand = candidatesByMint[w.mint];
        const gates = cand ? gateScore(cand.gates) : null;
        const change24 = e?.change24h;

        return (
          <div
            key={w.mint}
            onClick={() => onSelectMint(w.mint)}
            className="cursor-pointer rounded-lg border border-line bg-surface p-3 transition-colors hover:border-mut/40 hover:bg-raised"
          >
            <div className="flex items-center gap-3">
              <TokenIcon
                src={w.imageUrl || e?.imageUrl || undefined}
                symbol={w.symbol ?? e?.symbol ?? shortMint(w.mint)}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-white">
                  {w.symbol || e?.symbol ? (
                    <span className="mr-1 font-mono text-up">
                      {w.symbol ?? e?.symbol}
                    </span>
                  ) : null}
                  <span className="truncate">{w.name ?? shortMint(w.mint)}</span>
                </div>
                <div
                  className="font-mono text-[10px] text-mut"
                  title={fmtTimeET(w.addedAt)}
                >
                  starred {timeAgo(w.addedAt)}
                  {gates && (
                    <span className="ml-2">
                      <span className="font-bold text-gold">9</span>{" "}
                      {gates.passed}/{gates.total} gates
                    </span>
                  )}
                </div>
              </div>
              {/* since-added: the key column */}
              <div className="shrink-0 text-right">
                <div
                  className={cn(
                    "font-mono text-[15px] font-bold tabular-nums",
                    up && "text-up",
                    down && "text-down",
                    !up && !down && "text-mut"
                  )}
                >
                  {sincePct !== null ? fmtPct(sincePct) : "—"}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-mut">
                  {sinceUsd !== null ? fmtSignedUsd(sinceUsd, 4) : "—"}
                </div>
              </div>
              <button
                type="button"
                aria-label="Remove from watchlist"
                title="Remove from watchlist"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onRemove(w.mint);
                }}
                className="shrink-0 rounded p-1 text-mut/50 transition-colors hover:bg-raised hover:text-down"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/50 pt-2 font-mono text-[11px] tabular-nums">
              <span className="text-mut">
                at add{" "}
                <span className="text-white">
                  {w.priceAtAdd !== null ? fmtPrice(w.priceAtAdd) : "—"}
                </span>
              </span>
              <span className="text-mut">
                now{" "}
                <span className="text-white">
                  {live !== null ? fmtPrice(live) : "—"}
                </span>
              </span>
              <span className="text-mut">
                24h{" "}
                <span
                  className={cn(
                    change24 !== null && change24 !== undefined
                      ? change24 > 0
                        ? "text-up"
                        : change24 < 0
                          ? "text-down"
                          : "text-white"
                      : "text-mut"
                  )}
                >
                  {fmtPct(change24)}
                </span>
              </span>
              <span className="text-mut">
                MC <span className="text-white">{fmtCompactUsd(e?.mcapUsd)}</span>
              </span>
              {cand?.verdict === "ALERT" && (
                <Badge variant="gold" className="px-1 py-0 text-[10px]">
                  ALERT
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
