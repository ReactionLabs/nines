"use client";

import { Badge } from "@/components/ui/badge";
import type { IntelDetail } from "@/lib/holder-intel";
import { fmtCount, fmtShare } from "@/lib/holder-intel";
import { shortMint, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

function Stat({ label, value, tone, title }: {
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

function FlagRow({ label, children, hint }: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="font-mono text-xs text-white">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-mut">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Unavailable({ reason }: { reason?: string }) {
  return (
    <Badge variant="gray" title={reason ?? "Could not be verified on-chain"}>
      unavailable
    </Badge>
  );
}

/**
 * Full holder-intel breakdown for the token drawer. Every metric that could
 * not be verified on-chain renders as "unavailable" with its reason — the
 * section never shows a placeholder number.
 */
export function HolderIntelDetail({
  detail,
  loading,
}: {
  detail: IntelDetail | null | undefined;
  loading: boolean;
}) {
  if (loading && !detail) {
    return (
      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
          Holder intel · on-chain
        </p>
        <p className="rounded-md border border-line bg-bg p-3 font-mono text-xs text-mut">
          Scanning holders…
        </p>
      </div>
    );
  }
  if (!detail) return null;
  if (!detail.ok) {
    return (
      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-mut">
          Holder intel · on-chain
        </p>
        <p className="rounded-md border border-line bg-bg p-3 font-mono text-xs text-mut">
          Holder intel unavailable: {detail.reason ?? "fetch failed"}
        </p>
      </div>
    );
  }

  const d = detail;
  const growth =
    d.holders.growthPct === null
      ? d.holders.prevCount !== null
        ? "first scan"
        : "unavailable"
      : `${d.holders.growthPct >= 0 ? "+" : ""}${d.holders.growthPct.toFixed(1)}%`;
  const hp = d.honeypot;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-mut">
          Holder intel · on-chain
        </p>
        <p className="font-mono text-[10px] text-mut/70" title="When this data was read from Solana">
          {timeAgo(d.fetchedAt)}
          {d.cached ? " · cached" : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Holders"
          value={fmtCount(d.holders.count)}
          title={d.holders.prevAt ? `Was ${fmtCount(d.holders.prevCount)} ${timeAgo(d.holders.prevAt)}` : "Holder count from nonzero-balance token accounts"}
        />
        <Stat
          label="Holder growth"
          value={growth}
          tone={d.holders.growthPct === null ? undefined : d.holders.growthPct >= 0 ? "up" : "down"}
          title={d.holders.prevAt ? `vs ${fmtCount(d.holders.prevCount)} at ${timeAgo(d.holders.prevAt)}` : undefined}
        />
        <Stat
          label="Top holder"
          value={fmtShare(d.topHolder?.pct)}
          title={d.topHolder ? `Largest single account: ${d.topHolder.address}\nOwner: ${d.topHolder.owner} (${d.topHolder.kind})` : undefined}
        />
        <Stat
          label="Dev wallet"
          value={fmtShare(d.dev?.pct)}
          title={d.dev ? `${d.dev.wallet}\n${d.dev.method}` : d.devUnavailableReason}
        />
        <Stat
          label={`Snipers (${d.snipers.windowSec}s)`}
          value={d.snipers.count === null ? "unavailable" : d.snipers.count.toLocaleString("en-US")}
          title={d.snipers.reason ?? d.snipers.method}
        />
        <Stat
          label="Bundled supply"
          value="unavailable"
          title="Funding-graph clustering of linked wallets is not implemented; any number would be a guess."
        />
      </div>

      {/* top holders */}
      {d.top5.length > 0 && (
        <div className="mt-2 rounded-md border border-line bg-bg p-3">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-mut">
            Largest accounts
          </p>
          {d.top5.map((t, i) => (
            <div key={t.address} className="flex items-center justify-between gap-2 py-1">
              <span className="truncate font-mono text-[11px] text-mut" title={`Account: ${t.address}\nOwner: ${t.owner}`}>
                <span className="text-white/70">#{i + 1}</span> {shortMint(t.owner)}
                {t.kind === "program" && <span className="ml-1 text-[10px] text-info">[program]</span>}
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-white">
                {fmtShare(t.pct)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* security flags */}
      <div className="mt-2 divide-y divide-line/50 rounded-md border border-line bg-bg px-3 py-1">
        <FlagRow
          label="Mint authority"
          hint={d.mintAuthority ? `Set: ${shortMint(d.mintAuthority)}` : "No new tokens can be minted"}
        >
          {d.mintAuthorityRenounced === null ? (
            <Unavailable />
          ) : d.mintAuthorityRenounced ? (
            <Badge variant="green">renounced</Badge>
          ) : (
            <Badge variant="red">set</Badge>
          )}
        </FlagRow>
        <FlagRow
          label="Freeze authority"
          hint={d.freezeAuthority ? `Set: ${shortMint(d.freezeAuthority)}` : "Transfers cannot be frozen"}
        >
          {d.freezeAuthorityRenounced === null ? (
            <Unavailable />
          ) : d.freezeAuthorityRenounced ? (
            <Badge variant="green">renounced</Badge>
          ) : (
            <Badge variant="red">set</Badge>
          )}
        </FlagRow>
        <FlagRow label="Burned supply" hint="Share of supply in the incinerator address">
          {d.burnedPct === null ? (
            <Unavailable />
          ) : (
            <span className="font-mono text-xs tabular-nums text-white">{fmtShare(d.burnedPct)}</span>
          )}
        </FlagRow>
        <FlagRow
          label="LP burn"
          hint="LP-token attribution across AMM variants is not implemented"
        >
          <Unavailable reason="LP burn detection is not implemented for this pair type" />
        </FlagRow>
        <FlagRow
          label="Honeypot check"
          hint={
            hp.sellable === true
              ? "Jupiter-built sell from a real holder simulated clean"
              : hp.sellable === false
                ? hp.reason
                : hp.reason ?? "Simulation could not run"
          }
        >
          {hp.sellable === null ? (
            <Unavailable reason={hp.reason} />
          ) : hp.sellable ? (
            <Badge variant="green" title={hp.method}>sellable</Badge>
          ) : (
            <Badge variant="red" title={hp.method}>unsellable</Badge>
          )}
        </FlagRow>
      </div>

      {/* methodology */}
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-mut/70">
        Read-only Helius RPC. Sniper/dev detection needs the token&apos;s first
        transaction{!d.genesisReached && " — history was too deep to reach it, so those are unavailable"}.
        A simulated sell is not a guarantee; it reflects Jupiter routing at scan time.
      </p>
    </div>
  );
}
