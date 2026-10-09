/**
 * Shared types for the holder-intel API (/api/token-holder-intel) and its
 * React consumers. Null = the metric could not be verified on-chain and must
 * render as "unavailable", never as a placeholder number.
 */

export interface TopEntry {
  /** Token account address (the holding account). */
  address: string;
  /** Owner of the token account. */
  owner: string;
  /** Share of total supply, 0..100, null when unverifiable. */
  pct: number | null;
  kind: "wallet" | "program" | "unknown";
}

export interface HolderGrowth {
  count: number | null;
  prevCount: number | null;
  prevAt: number | null;
  /** Percent change vs prevCount, null when there is no earlier observation. */
  growthPct: number | null;
}

export interface DevInfo {
  wallet: string;
  /** Current share of supply held by the dev wallet, null when unverifiable. */
  pct: number | null;
  method: string;
}

export interface HoneypotInfo {
  /** True when a simulated sell succeeded, false when it reverted, null
   *  when the test could not run (no route, RPC failure, ...). */
  sellable: boolean | null;
  method: string;
  reason?: string;
  simulatedAt?: number;
}

export interface IntelBase {
  mint: string;
  ok: boolean;
  reason?: string;
  fetchedAt: number;
  cached: boolean;
  decimals: number | null;
  supply: number | null;
  holders: HolderGrowth;
  topHolder: TopEntry | null;
  top5: TopEntry[];
  dev: DevInfo | null;
  devUnavailableReason?: string;
  mintAuthority: string | null;
  mintAuthorityRenounced: boolean | null;
  freezeAuthority: string | null;
  freezeAuthorityRenounced: boolean | null;
  /** LP burn % — currently always null (not implemented, see route notes). */
  lpBurnPct: null;
  notes: string[];
}

export interface IntelDetail extends IntelBase {
  genesisReached: boolean;
  firstSeenOnchain: number | null;
  snipers: {
    count: number | null;
    windowSec: number;
    method: string;
    reason?: string;
  };
  /** Bundled supply % — always null (not implemented, see route notes). */
  bundledPct: null;
  burnedPct: number | null;
  honeypot: HoneypotInfo;
}

/** "12.3%" or "unavailable" — the honesty contract in one helper. */
export function fmtShare(pct: number | null | undefined): string {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "unavailable";
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(pct < 10 ? 2 : 1)}%`;
}

/** "4,665" or "unavailable". */
export function fmtCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unavailable";
  return Math.round(n).toLocaleString("en-US");
}
