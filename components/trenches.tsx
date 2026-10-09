"use client";

import { useMemo, useState } from "react";
import type { Candidate } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import type { LifecycleStage } from "@/lib/lifecycle";
import { STAGE_LABEL } from "@/lib/lifecycle";
import { useLifecycle, type LifeMap } from "@/lib/use-lifecycle";
import {
  fmtCompactUsd,
  gateScore,
  shortMint,
  timeAgo,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { TokenIcon } from "@/components/token-image";
import { WatchStar } from "@/components/watch-star";
import { HolderIntelRow } from "@/components/holder-intel-row";
import type { IntelBase } from "@/lib/holder-intel";

export type StageFilter = "all" | LifecycleStage;

interface TrenchesProps {
  candidates: Candidate[];
  byMint: Record<string, EnrichedToken>;
  onBuy: (c: Candidate) => void;
  onSelect: (c: Candidate) => void;
  watchedMints: Set<string>;
  onToggleWatch: (c: Candidate) => void;
  /** Shared lifecycle map (from useLifecycle at the dashboard level).
   *  When provided, Trenches skips its own fetch. */
  life?: LifeMap;
  /** Compact holder intel by mint (from useHolderIntel at the dashboard
   *  level). Optional: cards render without it until it arrives. */
  intelByMint?: Record<string, IntelBase>;
}

function GateBadge({ gates }: { gates: Candidate["gates"] }) {
  const score = gateScore(gates);
  const cleared = score.passed === score.total && score.total > 0;
  return (
    <span
      title={`${score.passed} of ${score.total} Nines gates passed`}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]",
        cleared
          ? "bg-up/15 text-up"
          : "bg-raised text-mut"
      )}
    >
      <span className="font-bold text-gold">9</span>
      {score.passed}/{score.total}
    </span>
  );
}

function TokenCard({
  c,
  enriched,
  intel,
  onBuy,
  onSelect,
  watched,
  onToggleWatch,
}: {
  c: Candidate;
  enriched: EnrichedToken | undefined;
  intel: IntelBase | undefined;
  onBuy: (c: Candidate) => void;
  onSelect: (c: Candidate) => void;
  watched: boolean;
  onToggleWatch: (c: Candidate) => void;
}) {
  const name =
    enriched?.name || enriched?.symbol || `${shortMint(c.mint)}pump`;
  const symbol = enriched?.symbol;
  const mcap = enriched?.mcapUsd;
  const vol = c.volume_usd ?? enriched?.vol24h;
  const img = c.image_url || enriched?.imageUrl || undefined;

  return (
    <div
      onClick={() => onSelect(c)}
      className="group cursor-pointer rounded-lg border border-line bg-surface p-2.5 transition-colors hover:border-mut/40 hover:bg-raised"
    >
      <div className="flex items-start gap-2.5">
        <TokenIcon src={img} symbol={symbol ?? name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="truncate text-[13px] font-semibold text-white">
              {symbol && (
                <span className="mr-1 font-mono text-up">{symbol}</span>
              )}
              <span className="truncate">{name}</span>
            </div>
            <div className="shrink-0 font-mono text-[11px] text-mut">
              V{" "}
              <span className="text-white">{fmtCompactUsd(vol)}</span>
              {"  "}MC{" "}
              <span className="text-white">{fmtCompactUsd(mcap)}</span>
            </div>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-mut">
              {timeAgo(c.first_seen)}
            </span>
            <GateBadge gates={c.gates} />
          </div>
          {/* holder intel — compact on-chain row */}
          <div className="mt-1">
            <HolderIntelRow intel={intel} />
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-mut/70">
          {shortMint(c.mint)}
        </span>
        <div className="flex items-center gap-1">
          <WatchStar
            watched={watched}
            onToggle={() => onToggleWatch(c)}
            size="sm"
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              onBuy(c);
            }}
            className="rounded-md bg-[#3b5bff] px-3 py-1 font-mono text-[11px] font-semibold text-white transition-transform hover:scale-105 active:scale-95"
          >
            Buy
          </button>
        </div>
      </div>
      {c.alerted && (
        <div className="mt-1.5 rounded bg-gold/10 px-2 py-1 font-mono text-[10px] text-gold">
          Cleared the Nines
        </div>
      )}
    </div>
  );
}

const COLUMNS: { stage: LifecycleStage; hint: string }[] = [
  { stage: "new", hint: "Fresh launches on the curve" },
  { stage: "final", hint: "Curve nearly complete" },
  { stage: "migrated", hint: "Graduated to DEX" },
];

export function Trenches({
  candidates,
  byMint,
  onBuy,
  onSelect,
  watchedMints,
  onToggleWatch,
  life: lifeProp,
  intelByMint,
}: TrenchesProps) {
  const [stageTab, setStageTab] = useState<StageFilter>("all");
  const mints = useMemo(() => candidates.map((c) => c.mint), [candidates]);
  const internalLife = useLifecycle(lifeProp ? [] : mints);
  const life = lifeProp ?? internalLife;

  const byStage = useMemo(() => {
    const out: Record<LifecycleStage, Candidate[]> = {
      new: [],
      final: [],
      migrated: [],
      unknown: [],
    };
    for (const c of candidates) {
      const info = life[c.mint];
      const stage: LifecycleStage = info?.stage ?? "unknown";
      out[stage].push(c);
    }
    // Newest first within each column.
    for (const k of Object.keys(out) as LifecycleStage[]) {
      out[k].sort((a, b) => (b.first_seen ?? 0) - (a.first_seen ?? 0));
    }
    return out;
  }, [candidates, life]);

  const visible: LifecycleStage[] =
    stageTab === "all" ? ["new", "final", "migrated"] : [stageTab];

  return (
    <div>
      {/* Stage tabs */}
      <div className="mb-3 flex items-center gap-1 overflow-x-auto">
        {(
          [
            { v: "all", label: "All" },
            ...COLUMNS.map((c) => ({
              v: c.stage as StageFilter,
              label: `${STAGE_LABEL[c.stage]} (${byStage[c.stage].length})`,
            })),
          ] as { v: StageFilter; label: string }[]
        ).map((t) => (
          <button
            key={t.v}
            onClick={() => setStageTab(t.v)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 font-mono text-[12px] transition-colors",
              stageTab === t.v
                ? "bg-gold text-black font-semibold"
                : "bg-surface text-mut hover:text-white"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Columns: 3 on desktop, 1 on phone */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {visible.map((stage) => (
          <section key={stage} aria-label={STAGE_LABEL[stage]}>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-white">
                {STAGE_LABEL[stage]}
              </h2>
              <span className="font-mono text-[11px] text-mut">
                {byStage[stage].length}
              </span>
            </div>
            <div className="space-y-2">
              {byStage[stage].map((c) => (
                <TokenCard
                  key={c.mint}
                  c={c}
                  enriched={byMint[c.mint]}
                  intel={intelByMint?.[c.mint]}
                  onBuy={onBuy}
                  onSelect={onSelect}
                  watched={watchedMints.has(c.mint)}
                  onToggleWatch={onToggleWatch}
                />
              ))}
              {byStage[stage].length === 0 && (
                <div className="rounded-lg border border-dashed border-line p-6 text-center font-mono text-[11px] text-mut">
                  No tokens in this stage right now
                </div>
              )}
            </div>
          </section>
        ))}
      </div>

      {byStage.unknown.length > 0 && stageTab === "all" && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] font-semibold text-mut">
            Unstaged ({byStage.unknown.length})
            <span className="ml-2 font-mono text-[10px] font-normal">
              lifecycle not yet determined
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {byStage.unknown.slice(0, 9).map((c) => (
              <TokenCard
                key={c.mint}
                c={c}
                enriched={byMint[c.mint]}
                intel={intelByMint?.[c.mint]}
                onBuy={onBuy}
                onSelect={onSelect}
                watched={watchedMints.has(c.mint)}
                onToggleWatch={onToggleWatch}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
