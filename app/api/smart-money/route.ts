/**
 * Smart Money engine — our native wallet tracker. No GMGN.
 *
 * GET /api/smart-money
 * -> {
 *      ok: true,
 *      updatedAt: number,       // unix seconds, last discovery run
 *      wallets: Array<{         // ranked by score, highest first
 *        address: string,
 *        score: number,         // 0-100
 *        wins: number,
 *        total: number,
 *        win_rate: number,       // 0-1
 *        labels: string[],       // SMART MONEY, WHALE, SNIPER, DEV, FRESH
 *        last_seen: number,      // unix seconds
 *        tokens: string[],       // recent token mints (truncated)
 *      }>,
 *      buys: Array<{            // recent buys by tracked wallets, newest first
 *        wallet: string,
 *        wallet_short: string,
 *        labels: string[],
 *        mint: string,
 *        symbol: string,
 *        amount: number,
 *        gate_score: string,     // e.g. "7/9"
 *        time: number,
 *        signature: string,
 *      }>,
 *      buysUpdatedAt: number,
 *    }
 *
 * Discovery runs box-side (smart_money.py) and monitoring runs via
 * smart_money_watch.py. Both publish to the PRIVATE repo's
 * data/smart-money.json and data/smart-money-buys.json, baked at build time.
 * Wallet addresses are Dip's IP — never the public repo.
 *
 * behind the session gate like every other /api/* route.
 */
export const dynamic = "force-dynamic";

import smartMoney from "@/data/smart-money.json";
import smartMoneyBuys from "@/data/smart-money-buys.json";

interface Wallet {
  address?: string;
  score?: number;
  wins?: number;
  total?: number;
  win_rate?: number;
  labels?: string[];
  last_seen?: number;
  tokens?: string[];
}

interface Buy {
  wallet?: string;
  wallet_short?: string;
  labels?: string[];
  mint?: string;
  symbol?: string;
  amount?: number;
  gate_score?: string;
  time?: number;
  signature?: string;
}

export async function GET() {
  const wallets: Wallet[] = Array.isArray(
    (smartMoney as { wallets?: Wallet[] }).wallets
  )
    ? (smartMoney as { wallets: Wallet[] }).wallets
    : [];
  const buys: Buy[] = Array.isArray(
    (smartMoneyBuys as { buys?: Buy[] }).buys
  )
    ? (smartMoneyBuys as { buys: Buy[] }).buys
    : [];

  return Response.json({
    ok: true,
    updatedAt: (smartMoney as { updated_at?: number }).updated_at ?? 0,
    wallets: wallets.map((w) => ({
      address: w.address ?? "",
      short: (w.address ?? "").slice(0, 4) + "…" + (w.address ?? "").slice(-4),
      score: w.score ?? 0,
      wins: w.wins ?? 0,
      total: w.total ?? 0,
      win_rate: w.win_rate ?? 0,
      labels: w.labels ?? [],
      last_seen: w.last_seen ?? 0,
    })),
    buys: buys.slice(0, 50).map((b) => ({
      wallet: b.wallet ?? "",
      wallet_short: b.wallet_short ?? "",
      labels: b.labels ?? [],
      mint: b.mint ?? "",
      symbol: b.symbol ?? "?",
      amount: b.amount ?? 0,
      gate_score: b.gate_score ?? "?/9",
      time: b.time ?? 0,
      signature: b.signature ?? "",
    })),
    buysUpdatedAt:
      (smartMoneyBuys as { updated_at?: number }).updated_at ?? 0,
  });
}
