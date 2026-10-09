/**
 * v1 bot API: tracked-wallet buys for a token.
 *
 * GET /api/v1/whale-buys?mint={mint}
 * -> { ok, mint, updatedAt, walletCount, buys[] }
 *    buys[]: { wallet, amount, time (unix s), signature } — newest first.
 *
 * Detection runs box-side on the tracked whitelist; empty whitelist ->
 * valid empty buys array. The pipeline lights up when wallets are supplied.
 *
 * Auth: X-API-Key header or ?key= (see docs/api-v1.md).
 */
export const dynamic = "force-dynamic";

import whaleBuys from "@/data/whale-buys.json";
import { v1err } from "@/lib/bot-auth";

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
    return v1err("invalid_mint", "mint must be a 32-44 char base58 address", 400);
  }
  const all: Buy[] = Array.isArray((whaleBuys as { buys?: Buy[] }).buys)
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
    count: buys.length,
    buys,
  });
}
