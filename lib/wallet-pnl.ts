/**
 * Wallet PnL engine — pure functions for cost-basis computation.
 *
 * Cost model: SOL-denominated average cost. For each token, we walk the
 * wallet's swap history (oldest first) and track:
 *   - acquired: net tokens bought
 *   - costSol: net SOL paid
 *   - costUsdStable: net USD paid via stablecoins (USDC/USDT at $1)
 *
 * PnL% is computed as (value - cost) / cost where cost is converted to USD
 * at the CURRENT SOL price. This isolates token performance from SOL price
 * moves, which is the right unit for a memecoin trader.
 *
 * Honesty rules:
 *   - Tokens held with no swap history -> basisStatus "unknown" (never $0 cost)
 *   - Tokens received only via transfers -> "transfer-in"
 *   - Sells reduce basis proportionally (average-cost method)
 */

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([USDC_MINT, USDT_MINT]);

export interface HeliusTokenTransfer {
  mint?: string;
  tokenAmount?: number;
  fromUserAccount?: string;
  toUserAccount?: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number; // lamports
}

export interface HeliusTx {
  signature?: string;
  type?: string;
  timestamp?: number;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
}

interface Lot {
  acquired: number;
  costSol: number;
  costUsdStable: number;
  transferIn: boolean;
  firstSeen: number; // earliest tx timestamp
}

/** Per-mint cost lots derived from swap history. */
export function computeLots(
  wallet: string,
  txns: HeliusTx[]
): Map<string, Lot> {
  const lots = new Map<string, Lot>();
  const get = (m: string, ts: number): Lot => {
    let l = lots.get(m);
    if (!l) {
      l = { acquired: 0, costSol: 0, costUsdStable: 0, transferIn: false, firstSeen: ts };
      lots.set(m, l);
    }
    if (ts < l.firstSeen) l.firstSeen = ts;
    return l;
  };

  const sorted = [...txns].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  for (const tx of sorted) {
    const ts = tx.timestamp ?? 0;
    const tts = tx.tokenTransfers ?? [];
    const nts = tx.nativeTransfers ?? [];

    if (tx.type !== "SWAP") {
      // Flag transfer-ins (non-swap receipts) for honest "unknown cost" labeling.
      for (const tt of tts) {
        if (
          tt.mint &&
          tt.mint !== SOL_MINT &&
          tt.toUserAccount === wallet &&
          tt.fromUserAccount !== wallet &&
          (tt.tokenAmount ?? 0) > 0
        ) {
          get(tt.mint, ts).transferIn = true;
        }
      }
      continue;
    }

    let solOut = 0;
    let solIn = 0;
    const gave: { mint: string; amount: number }[] = [];
    const got: { mint: string; amount: number }[] = [];

    for (const nt of nts) {
      const amt = (nt.amount ?? 0) / 1e9;
      if (nt.fromUserAccount === wallet) solOut += amt;
      if (nt.toUserAccount === wallet) solIn += amt;
    }
    for (const tt of tts) {
      const mint = tt.mint;
      const amt = tt.tokenAmount ?? 0;
      if (!mint || !(amt > 0)) continue;
      if (mint === SOL_MINT) {
        if (tt.fromUserAccount === wallet) solOut += amt;
        if (tt.toUserAccount === wallet) solIn += amt;
      } else {
        if (tt.fromUserAccount === wallet) gave.push({ mint, amount: amt });
        if (tt.toUserAccount === wallet) got.push({ mint, amount: amt });
      }
    }

    const netSolOut = solOut - solIn;

    // Stablecoin flows in this swap (paid or received).
    let stableOut = 0;
    let stableIn = 0;
    for (const g of gave) if (STABLES.has(g.mint)) stableOut += g.amount;
    for (const g of got) if (STABLES.has(g.mint)) stableIn += g.amount;

    // Tokens bought: non-stable tokens received. Attribute cost.
    const buyTokens = got.filter((g) => !STABLES.has(g.mint));
    const totalCostSol = Math.max(0, netSolOut);
    const totalCostStable = Math.max(0, stableOut - stableIn);
    if (buyTokens.length > 0 && (totalCostSol > 0 || totalCostStable > 0)) {
      // Split cost across received tokens (single-pair swaps dominate; split is the honest fallback).
      const perSol = totalCostSol / buyTokens.length;
      const perStable = totalCostStable / buyTokens.length;
      for (const g of buyTokens) {
        const lot = get(g.mint, ts);
        lot.acquired += g.amount;
        lot.costSol += perSol;
        lot.costUsdStable += perStable;
      }
    } else if (buyTokens.length > 0) {
      // Received tokens with no detectable cost (e.g. paid in another token).
      // Track acquisition so "unknown cost" is accurate, not zero.
      for (const g of buyTokens) get(g.mint, ts).acquired += g.amount;
    }

    // Tokens sold: reduce basis proportionally (average-cost).
    for (const g of gave) {
      if (STABLES.has(g.mint)) continue;
      const lot = lots.get(g.mint);
      if (lot && lot.acquired > 1e-12) {
        const reduce = Math.min(g.amount, lot.acquired);
        const frac = reduce / lot.acquired;
        lot.acquired -= reduce;
        lot.costSol -= lot.costSol * frac;
        lot.costUsdStable -= lot.costUsdStable * frac;
        if (lot.acquired < 1e-9) {
          lot.acquired = 0;
          lot.costSol = 0;
          lot.costUsdStable = 0;
        }
      }
    }
  }

  return lots;
}

export type BasisStatus = "ok" | "unknown" | "transfer-in";

export interface TokenPnlInput {
  mint: string;
  symbol: string | null;
  name: string | null;
  balance: number;
  priceUsd: number | null;
  change24h: number | null;
  imageUrl: string | null;
}

export interface TokenPnl extends TokenPnlInput {
  valueUsd: number | null;
  avgCostSol: number | null;
  costUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  basisStatus: BasisStatus;
}

export interface CostLot {
  acquired: number;
  costSol: number;
  costUsdStable: number;
  transferIn: boolean;
}

/**
 * Combine on-chain balances + current prices + cost lots into per-token PnL.
 * solPriceUsd converts SOL-denominated cost to USD for display.
 * `lots` accepts either the Map from computeLots or the serialized
 * Record from /api/wallet/pnl.
 */
export function computeTokenPnl(
  inputs: TokenPnlInput[],
  lots: Map<string, Lot> | Record<string, CostLot>,
  solPriceUsd: number | null
): TokenPnl[] {
  const getLot = (mint: string): CostLot | undefined =>
    lots instanceof Map ? lots.get(mint) : lots[mint];
  return inputs.map((t) => {
    const priceUsd = t.priceUsd;
    const valueUsd =
      priceUsd !== null && t.balance > 0 ? t.balance * priceUsd : null;
    const lot = getLot(t.mint);

    let basisStatus: BasisStatus = "unknown";
    let avgCostSol: number | null = null;
    let costUsd: number | null = null;
    let pnlUsd: number | null = null;
    let pnlPct: number | null = null;

    if (lot && lot.acquired > 1e-12 && (lot.costSol > 0 || lot.costUsdStable > 0)) {
      basisStatus = "ok";
      avgCostSol = lot.costSol / lot.acquired;
      // Cost of the CURRENT balance (not lifetime acquired): scale by balance/acquired
      // when they differ (e.g. partial sells already reduced the lot, so use lot directly).
      const scale = t.balance > 0 ? Math.min(1, t.balance / lot.acquired) : 0;
      const costSolNow = lot.costSol * scale;
      const costStableNow = lot.costUsdStable * scale;
      if (solPriceUsd !== null) {
        costUsd = costSolNow * solPriceUsd + costStableNow;
        if (valueUsd !== null) {
          pnlUsd = valueUsd - costUsd;
          pnlPct = costUsd > 1e-9 ? pnlUsd / costUsd : null;
        }
      }
    } else if (lot?.transferIn) {
      basisStatus = "transfer-in";
    }

    return {
      ...t,
      valueUsd,
      avgCostSol,
      costUsd,
      pnlUsd,
      pnlPct,
      basisStatus,
    };
  });
}

export interface ValuePoint {
  t: number; // epoch ms, start of day
  value: number; // holdings value at current prices
  cost: number; // cumulative cost at current SOL price
}

/**
 * Reconstruct daily holdings value over time from swap history.
 * Uses CURRENT prices for all points — labeled "at current prices" in the UI.
 * Honest approximation of position sizing over time, not historical valuation.
 */
export function buildValueSeries(
  wallet: string,
  txns: HeliusTx[],
  prices: Map<string, number>, // mint -> current USD price
  solPriceUsd: number | null,
  maxPoints = 90
): ValuePoint[] {
  const sorted = [...txns].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (sorted.length === 0 || solPriceUsd === null) return [];

  // Replay to build per-day snapshots of (holdings, cost).
  const DAY = 86400;
  const firstDay = Math.floor((sorted[0].timestamp ?? 0) / DAY) * DAY;
  const lastDay = Math.floor(Date.now() / 1000 / DAY) * DAY;

  // Cumulative lots replayed day by day.
  const lots = new Map<string, Lot>();
  const get = (m: string): Lot => {
    let l = lots.get(m);
    if (!l) {
      l = { acquired: 0, costSol: 0, costUsdStable: 0, transferIn: false, firstSeen: 0 };
      lots.set(m, l);
    }
    return l;
  };

  // Reuse the same swap logic by replaying through computeLots incrementally is
  // complex; instead, accumulate daily deltas with a simplified replay.
  type Delta = { mint: string; dAcq: number; dCostSol: number; dCostStable: number };
  const byDay = new Map<number, Delta[]>();
  const pushDelta = (day: number, d: Delta) => {
    const arr = byDay.get(day) ?? [];
    arr.push(d);
    byDay.set(day, arr);
  };

  for (const tx of sorted) {
    if (tx.type !== "SWAP") continue;
    const day = Math.floor((tx.timestamp ?? 0) / DAY) * DAY;
    const tts = tx.tokenTransfers ?? [];
    const nts = tx.nativeTransfers ?? [];
    let solOut = 0;
    let solIn = 0;
    const gave: { mint: string; amount: number }[] = [];
    const got: { mint: string; amount: number }[] = [];
    for (const nt of nts) {
      const amt = (nt.amount ?? 0) / 1e9;
      if (nt.fromUserAccount === wallet) solOut += amt;
      if (nt.toUserAccount === wallet) solIn += amt;
    }
    for (const tt of tts) {
      const mint = tt.mint;
      const amt = tt.tokenAmount ?? 0;
      if (!mint || !(amt > 0)) continue;
      if (mint === SOL_MINT) {
        if (tt.fromUserAccount === wallet) solOut += amt;
        if (tt.toUserAccount === wallet) solIn += amt;
      } else {
        if (tt.fromUserAccount === wallet) gave.push({ mint, amount: amt });
        if (tt.toUserAccount === wallet) got.push({ mint, amount: amt });
      }
    }
    const netSolOut = solOut - solIn;
    let stableOut = 0;
    let stableIn = 0;
    for (const g of gave) if (STABLES.has(g.mint)) stableOut += g.amount;
    for (const g of got) if (STABLES.has(g.mint)) stableIn += g.amount;
    const buyTokens = got.filter((g) => !STABLES.has(g.mint));
    const totalCostSol = Math.max(0, netSolOut);
    const totalCostStable = Math.max(0, stableOut - stableIn);
    if (buyTokens.length > 0) {
      const perSol = totalCostSol / buyTokens.length;
      const perStable = totalCostStable / buyTokens.length;
      for (const g of buyTokens)
        pushDelta(day, { mint: g.mint, dAcq: g.amount, dCostSol: perSol, dCostStable: perStable });
    }
    for (const g of gave) {
      if (STABLES.has(g.mint)) continue;
      pushDelta(day, { mint: g.mint, dAcq: -g.amount, dCostSol: 0, dCostStable: 0 });
    }
  }

  const points: ValuePoint[] = [];
  // Walk days, applying deltas with average-cost reduction for sells.
  for (let day = firstDay; day <= lastDay; day += DAY) {
    const deltas = byDay.get(day) ?? [];
    for (const d of deltas) {
      const lot = get(d.mint);
      if (d.dAcq >= 0) {
        lot.acquired += d.dAcq;
        lot.costSol += d.dCostSol;
        lot.costUsdStable += d.dCostStable;
      } else {
        const reduce = Math.min(-d.dAcq, lot.acquired);
        if (lot.acquired > 1e-12 && reduce > 0) {
          const frac = reduce / lot.acquired;
          lot.acquired -= reduce;
          lot.costSol -= lot.costSol * frac;
          lot.costUsdStable -= lot.costUsdStable * frac;
        }
      }
    }
    let value = 0;
    let cost = 0;
    lots.forEach((lot, mint) => {
      const px = prices.get(mint);
      if (px !== undefined && lot.acquired > 0) value += lot.acquired * px;
      cost += lot.costSol * solPriceUsd + lot.costUsdStable;
    });
    // Only emit from the first day with activity.
    if (points.length > 0 || value > 0 || cost > 0) {
      points.push({ t: day * 1000, value, cost });
    }
  }

  // Downsample to maxPoints.
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: ValuePoint[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}
