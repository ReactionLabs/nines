import type { JournalEntry } from "@/lib/types";

/**
 * Net PnL per closed trade. Spec: net = realized - entry*1.04
 * (the 4% haircut approximates fees + slippage).
 */
export function tradeNet(e: JournalEntry): number | null {
  if (!e.closed) return null;
  if (e.realized_usd === null || e.realized_usd === undefined) return null;
  return e.realized_usd - e.entry_usd * 1.04;
}

export function isClosed(entry: JournalEntry): boolean {
  return entry.closed && entry.realized_usd !== null && entry.realized_usd !== undefined;
}

export function hitRung(entry: JournalEntry, rungName: string): boolean {
  return (entry.rungs ?? []).some(
    (r) => String(r.n).toLowerCase() === rungName
  );
}

export interface TradeSummary {
  count: number;
  net: number;
  wins: number;
  winRate: number;
  rung1Rate: number;
  stopped: number;
  avg: number;
}

export function summarize(entries: JournalEntry[]): TradeSummary {
  const closed = entries.filter(isClosed);
  const nets = closed.map((e) => tradeNet(e) as number);
  const count = closed.length;
  const net = nets.reduce((a, b) => a + b, 0);
  const wins = nets.filter((n) => n > 0).length;
  const rung1 = closed.filter((e) => hitRung(e, "1")).length;
  const stopped = closed.filter((e) => hitRung(e, "stop")).length;
  return {
    count,
    net,
    wins,
    winRate: count ? wins / count : 0,
    rung1Rate: count ? rung1 / count : 0,
    stopped,
    avg: count ? net / count : 0,
  };
}

export interface EquityPoint {
  t: number;
  equity: number;
}

/** Cumulative equity curve from closed trades, ordered by close_time. */
export function equityCurve(entries: JournalEntry[]): EquityPoint[] {
  const closed = entries
    .filter(isClosed)
    .sort((a, b) => (a.close_time ?? 0) - (b.close_time ?? 0));
  let eq = 0;
  return closed.map((e) => {
    eq += tradeNet(e) as number;
    return { t: e.close_time as number, equity: eq };
  });
}
