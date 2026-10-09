"use client";

import { useEffect, useState } from "react";
// TokenDetail: full coin detail view, used by both the drawer (quick view)
// and the /coin/[mint] page (full page).
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { Candidate, Gate, Role } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import {
  fmtCompactUsd,
  fmtPct,
  fmtPrice,
  fmtTimeET,
  shortMint,
  timeAgo,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { TokenChart } from "@/components/token-chart";
import { TradeTape } from "@/components/trade-tape";
import { TokenIcon } from "@/components/token-image";
import { useTokenImages } from "@/lib/use-token-images";
import { WatchStar } from "@/components/watch-star";
import { HolderIntelDetail } from "@/components/holder-intel-detail";
import { useHolderIntelDetail } from "@/lib/use-holder-intel";

function GateBadge({ passed }: { passed: boolean | null }) {
  if (passed === true) return <Badge variant="green">PASS</Badge>;
  if (passed === false) return <Badge variant="red">FAIL</Badge>;
  return <Badge variant="gray">STUB</Badge>;
}

/** Holder / authority related gates get their own info block. */
function authorityRows(gates: Gate[]): Gate[] {
  return (gates ?? []).filter((g) =>
    /authorit|concentrat|holder|top10/i.test(g.name)
  );
}

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  title?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-bg p-3" title={title}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-mut">{label}</p>
      <p
        className={cn(
          "mt-1 truncate font-mono text-sm font-semibold tabular-nums",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          !tone && "text-white"
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function TokenDetail({
  candidate,
  enriched,
  role,
  watched,
  onToggleWatch,
  onExecute,
  headerActions,
}: {
  candidate: Candidate | null;
  enriched: EnrichedToken | null;
  role: Role;
  watched: boolean;
  onToggleWatch: () => void;
  onExecute: (c: Candidate) => void;
  headerActions?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [whaleBuys, setWhaleBuys] = useState<
    Array<{ wallet: string; amount: number; time: number; signature: string }>
  >([]);
  // Full holder intel + security flags for the open token (detail scan).
  const { detail: intelDetail, loading: intelLoading } = useHolderIntelDetail(
    candidate?.mint ?? null
  );

  // Logo for the open token when neither the scanner nor DexScreener
  // resolved one. Resolves async; the letter fallback holds until then.
  const { images } = useTokenImages(
    candidate && !candidate.image_url && !enriched?.imageUrl
      ? [candidate.mint]
      : []
  );
  const resolvedImage = candidate ? (images[candidate.mint] ?? null) : null;

  // Tracked-wallet buys for the open token (drives chart markers + list).
  useEffect(() => {
    if (!candidate) {
      setWhaleBuys([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/whale-buys?mint=${encodeURIComponent(candidate.mint)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.ok) setWhaleBuys(d.buys ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [candidate?.mint]);

  async function copyMint() {
    if (!candidate) return;
    try {
      await navigator.clipboard.writeText(candidate.mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const e = candidate ? enriched : null;
  const change = e?.change24h;

  if (!candidate) return null;
  return (
    <div className="space-y-5">
      {/* header: icon, title, badges, actions */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2.5">
            <TokenIcon
              src={candidate?.image_url || resolvedImage || e?.imageUrl}
              symbol={e?.symbol}
              size="md"
            />
            <h1 className="font-mono text-lg font-bold text-white">
              {candidate ? (e?.symbol ?? shortMint(candidate.mint)) : ""}
            </h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {candidate?.verdict === "ALERT" ? (
              <Badge variant="gold" className="animate-pulseGold">
                ALERT
              </Badge>
            ) : (
              <Badge variant="gray">PASS</Badge>
            )}
            <Badge variant="blue">{candidate?.tier ?? "n/a"}</Badge>
            <Badge variant="outline">{candidate?.launchpad ?? "n/a"}</Badge>
            {candidate?.partial && <Badge variant="outline">partial</Badge>}
          </div>
        </div>
        <div className="flex items-start gap-2">
          {candidate && (
            <WatchStar watched={watched} onToggle={onToggleWatch} />
          )}
          {headerActions}
        </div>
      </div>

        {candidate && (
          <div className="space-y-5">
            {/* token banner art (Dex Paid) — the token's own art only */}
            {e?.bannerUrl ? (
              <img
                src={e.bannerUrl}
                alt=""
                className="h-24 w-full rounded-md border border-line object-cover"
              />
            ) : null}
            {/* chart — native, on top */}
            <TokenChart
              mint={candidate.mint}
              whaleBuys={whaleBuys.map((b) => b.time)}
            />
            {/* live trade tape: on-chain buys/sells via Helius WS */}
            <TradeTape mint={candidate.mint} />
            <div className="-mt-3 flex flex-wrap gap-4">
              <a
                href={`https://dexscreener.com/solana/${encodeURIComponent(candidate.mint)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-info underline underline-offset-4 hover:text-white"
              >
                DexScreener ↗
              </a>
              <a
                href={`https://solscan.io/token/${encodeURIComponent(candidate.mint)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-info underline underline-offset-4 hover:text-white"
              >
                Solscan ↗
              </a>
            </div>

            {/* market stats — live quote (DexScreener), distinct from the
                scan-time figures recorded in the gate breakdown below */}
            <div>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
                Market · live quote
              </p>
              <div className="grid grid-cols-3 gap-2">
              <Stat label="Price" value={fmtPrice(e?.priceUsd)} />
              <Stat label="MCap" value={fmtCompactUsd(e?.mcapUsd)} />
              <Stat label="Liq" value={fmtCompactUsd(e?.liqUsd)} />
              <Stat label="Vol 24h" value={fmtCompactUsd(e?.vol24h)} />
              <Stat
                label="24h chg"
                value={fmtPct(change)}
                tone={change !== null && change !== undefined ? (change > 0 ? "up" : change < 0 ? "down" : undefined) : undefined}
              />
              <Stat
                label="First seen"
                value={timeAgo(candidate.first_seen)}
                title={fmtTimeET(candidate.first_seen)}
              />
              </div>
            </div>

            {/* tracked-wallet buys */}
            <div>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
                Tracked buys
              </p>
              {whaleBuys.length === 0 ? (
                <p className="rounded-md border border-line bg-bg p-3 text-xs text-mut">
                  No tracked-wallet buys yet — chart markers light up once
                  Dip&apos;s whale list is set.
                </p>
              ) : (
                <div className="space-y-2">
                  {whaleBuys.map((b) => (
                    <div
                      key={b.signature || `${b.wallet}-${b.time}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-line bg-bg p-3"
                    >
                      <span
                        className="font-mono text-xs text-white"
                        title={b.wallet}
                      >
                        {shortMint(b.wallet)}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-mut">
                        {b.amount.toLocaleString()} · {timeAgo(b.time)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* execute — buy ticket proximity */}
            {role === "dip" && (
              <div className="rounded-md border border-line bg-bg p-4">
                <p className="font-mono text-[11px] uppercase tracking-widest text-mut">
                  Execute · paper phase
                </p>
                <p className="mt-1 text-xs text-mut">
                  Opens a BUY ticket for $100. Confirming records an intent only;
                  no funds move.
                </p>
                <Button
                  variant="success"
                  size="sm"
                  className="mt-3"
                  onClick={() => onExecute(candidate)}
                >
                  Execute BUY $100
                </Button>
              </div>
            )}

            <Separator />

            {/* mint + reason */}
            <div className="space-y-3 font-mono text-sm">
              <div>
                <p className="text-[11px] uppercase tracking-widest text-mut">Mint</p>
                <p className="mt-1 flex items-center gap-2 break-all text-xs text-white">
                  <span>{candidate.mint}</span>
                  <Button variant="ghost" size="xs" onClick={copyMint}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-widest text-mut">Reason</p>
                <p className="mt-1 text-xs text-white">{candidate.reason || "n/a"}</p>
              </div>
            </div>

            <Separator />

            {/* authorities / concentration */}
            {authorityRows(candidate.gates).length > 0 && (
              <div>
                <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
                  Authorities &amp; concentration
                </p>
                <div className="space-y-2 rounded-md border border-line bg-bg p-3">
                  {authorityRows(candidate.gates).map((g) => (
                    <div key={g.n} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-xs text-white">{g.name}</p>
                        <p className="mt-0.5 text-xs text-mut">{g.detail || "n/a"}</p>
                      </div>
                      <GateBadge passed={g.passed} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* holder intel + security flags — read-only on-chain scan */}
            <HolderIntelDetail detail={intelDetail} loading={intelLoading} />

            <Separator />

            {/* full gate breakdown — figures are the scanner's evaluation
                at scan time, not live quotes */}
            <div>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
                Gate breakdown · 9 gates · evaluated {timeAgo(candidate.first_seen)}
              </p>
              <div className="space-y-2">
                {(candidate.gates ?? []).map((g) => (
                  <div
                    key={g.n}
                    className="flex items-start justify-between gap-3 rounded-md border border-line bg-bg p-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-white">
                        <span className="text-mut">#{g.n}</span> {g.name}
                      </p>
                      <p className="mt-0.5 text-xs text-mut">{g.detail || "n/a"}</p>
                    </div>
                    <GateBadge passed={g.passed} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
