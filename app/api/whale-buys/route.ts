/**
 * Tracked-wallet buys for a token.
 *
 * Bot-consumable contract:
 *   GET /api/whale-buys?mint={mint}
 *   -> {
 *        ok: true,
 *        mint: string,          // requested mint
 *        updatedAt: number,     // unix seconds, last detection run
 *        walletCount: number,   // tracked wallets (0 until Dip supplies the list)
 *        buys: Array<{
 *          wallet: string,     // full tracked-wallet address
 *          amount: number,      // tokens received
 *          time: number,        // unix seconds
 *          signature: string,   // solana tx signature
 *        }>                    // newest first
 *      }
 *
 * Detection runs box-side (watcher/whale_buys.py via the Helius Enhanced
 * Transactions API on wallets/whitelist.txt) and is published to the
 * PRIVATE repo's data/whale-buys.json, baked at build time. The whitelist
 * itself is never published. Empty whitelist -> valid empty buys array;
 * the pipeline lights up the moment wallets are supplied.
 *
 * behind the session gate like every other /api/* route.
 */
export const dynamic = "force-dynamic";

import whaleBuys from "@/data/whale-buys.json";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Buy {
  mint?: string;
  wallet?: string;
  amount?: number;
  time?: number;
  signature?: string;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mint = (searchParams.get("mint") ?? "").trim();
  if (!MINT_RE.test(mint)) {
    return Response.json({ ok: false, reason: "invalid mint" }, { status: 400 });
  }
  const all: Buy[] = Array.isArray(
    (whaleBuys as { buys?: Buy[] }).buys
  )
    ? (whaleBuys as { buys: Buy[] }).buys
    : [];
  const buys = all
    .filter((b) => b.mint === mint)
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .map((b) => ({
      wallet: b.wallet ?? "",
      amount: b.amount ?? 0,
      time: b.time ?? 0,
      signature: b.signature ?? "",
    }));
  return Response.json({
    ok: true,
    mint,
    updatedAt: (whaleBuys as { updated_at?: number }).updated_at ?? 0,
    walletCount: (whaleBuys as { wallet_count?: number }).wallet_count ?? 0,
    buys,
  });
}
