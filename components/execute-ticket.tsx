"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WalletConnectButton } from "@/components/wallet-connect";
import type { Candidate } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import { fmtPrice, shortMint } from "@/lib/format";

const SIZE_USD = 100;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

/** base64 <-> bytes without Node's Buffer (client-safe). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

type Phase =
  | "idle"
  | "quoting"
  | "quoted"
  | "signing"
  | "executing"
  | "done"
  | "failed";

interface Quote {
  requestId: string;
  transaction: string;
  outAmount: string;
  inAmount: string;
  router: string;
  feeBps?: number;
  inLamports: number;
  outTokens: number | null;
  solPrice: number;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-xs uppercase tracking-widest text-mut">{label}</span>
      <span className="font-mono text-sm text-white">{children}</span>
    </div>
  );
}

/** Tolerant parse of Jupiter price/v3 shapes. */
function parseUsdPrice(data: unknown, mint: string): number | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const candidates: unknown[] = [
    (root.data as Record<string, unknown> | undefined)?.[mint],
    root[mint],
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      for (const k of ["usdPrice", "price"]) {
        const v = Number(o[k]);
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  }
  return null;
}

/**
 * Self-custodial BUY ticket. Side is fixed BUY, size is fixed $100.
 *
 * Flow: connect wallet -> Jupiter quote -> explicit user confirmation ->
 * wallet signs -> Jupiter executes. The server never signs and never sees
 * private keys; signing happens entirely inside the user's wallet.
 * Nothing executes without the user pressing "Confirm swap".
 */
export function ExecuteTicket({
  open,
  onOpenChange,
  candidate,
  enriched,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: Candidate | null;
  enriched: EnrichedToken | null;
}) {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>("idle");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const walletAddress = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);

  // Fresh state every time the ticket opens on a new token.
  useEffect(() => {
    if (open) {
      setPhase("idle");
      setQuote(null);
      setSignature(null);
      setError(null);
    }
  }, [open, candidate?.mint]);

  function close() {
    setPhase("idle");
    setQuote(null);
    setSignature(null);
    setError(null);
    onOpenChange(false);
  }

  async function getQuote() {
    if (!candidate || !walletAddress) return;
    setPhase("quoting");
    setError(null);
    try {
      // 1. Record the intent (dip-only; 403 for other roles blocks the trade).
      const intentRes = await fetch("/api/trade/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mint: candidate.mint, tier: candidate.tier, size_usd: SIZE_USD }),
      });
      if (!intentRes.ok) {
        const d = await intentRes.json().catch(() => ({}));
        throw new Error(d?.message ?? "Trade intent denied.");
      }

      // 2. SOL price -> lamports for $100.
      const priceRes = await fetch(`/api/jupiter/price?ids=${SOL_MINT}`);
      const priceData = await priceRes.json().catch(() => null);
      const solPrice = parseUsdPrice(priceData, SOL_MINT);
      if (!solPrice) throw new Error("Could not price SOL for the quote.");
      const inLamports = Math.floor((SIZE_USD / solPrice) * LAMPORTS_PER_SOL);
      if (inLamports <= 0) throw new Error("Quote amount invalid.");

      // 3. Jupiter order.
      const orderRes = await fetch(
        `/api/jupiter/order?` +
          new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: candidate.mint,
            amount: String(inLamports),
            taker: walletAddress,
          })
      );
      const order = await orderRes.json().catch(() => null);
      if (!orderRes.ok || !order) {
        throw new Error(order?.error ?? "Jupiter quote failed.");
      }
      if (!order.transaction) {
        throw new Error(
          order.errorMessage ?? `Jupiter could not build this swap (router ${order.router ?? "?"}).`
        );
      }

      // 4. Output token decimals for display.
      let outTokens: number | null = null;
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(candidate.mint));
        const decimals = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed
          ?.info?.decimals;
        if (typeof decimals === "number") {
          outTokens = Number(order.outAmount) / 10 ** decimals;
        }
      } catch {
        // display-only; the swap itself doesn't need this
      }

      setQuote({
        requestId: order.requestId,
        transaction: order.transaction,
        outAmount: order.outAmount,
        inAmount: order.inAmount,
        router: order.router ?? "jupiter",
        feeBps: typeof order.feeBps === "number" ? order.feeBps : undefined,
        inLamports,
        outTokens,
        solPrice,
      });
      setPhase("quoted");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quote failed.");
      setPhase("failed");
    }
  }

  async function confirmSwap() {
    if (!quote || !signTransaction) return;
    setPhase("signing");
    setError(null);
    try {
      // Deserialize the Jupiter-built transaction and have the wallet sign it.
      const tx = VersionedTransaction.deserialize(b64ToBytes(quote.transaction));
      const signed = await signTransaction(tx);
      const signedB64 = bytesToB64(signed.serialize());

      setPhase("executing");
      const execRes = await fetch("/api/jupiter/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTransaction: signedB64, requestId: quote.requestId }),
      });
      const exec = await execRes.json().catch(() => null);
      if (!execRes.ok || !exec || exec.status !== "Success") {
        throw new Error(exec?.error ?? `Swap failed (code ${exec?.code ?? "?"}).`);
      }
      setSignature(exec.signature);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed.");
      setPhase("failed");
    }
  }

  const busy = phase === "quoting" || phase === "signing" || phase === "executing";
  const symbol = enriched?.symbol ?? (candidate ? shortMint(candidate.mint) : "");
  const solIn = quote ? quote.inLamports / LAMPORTS_PER_SOL : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogTitle>BUY ticket</DialogTitle>
      <DialogDescription>
        {phase === "quoted"
          ? "Review the exact swap, then confirm. Your wallet signs — nothing else can move these funds."
          : "Self-custodial swap via Jupiter. Your wallet signs every trade."}
      </DialogDescription>

      {!connected && (
        <div className="mt-4 rounded-md border border-line bg-bg p-4">
          <p className="mb-3 font-mono text-xs text-mut">
            Connect the wallet you want to trade from. It becomes your trading wallet.
          </p>
          <WalletConnectButton />
        </div>
      )}

      {candidate && (
        <div className="mt-4 space-y-3 rounded-md border border-line bg-bg p-4">
          <Row label="Token">
            <span className="font-semibold">{symbol}</span>
          </Row>
          <Row label="Side">
            <Badge variant="green" className="font-semibold">BUY · fixed</Badge>
          </Row>
          <Row label="Size">
            ${SIZE_USD} <span className="text-mut">· fixed</span>
          </Row>
          <Row label="Wallet">
            {walletAddress ? (
              <span className="tabular-nums">
                {walletAddress.slice(0, 4)}…{walletAddress.slice(-4)}
              </span>
            ) : (
              <span className="text-mut">not connected</span>
            )}
          </Row>
          {phase === "quoted" && quote && (
            <>
              <div className="border-t border-line pt-3 space-y-3">
                <Row label="You pay">
                  <span className="tabular-nums">
                    {solIn.toFixed(4)} SOL <span className="text-mut">(~${SIZE_USD})</span>
                  </span>
                </Row>
                <Row label="You receive">
                  {quote.outTokens != null ? (
                    <span className="tabular-nums text-up">
                      ~{quote.outTokens.toLocaleString("en-US", { maximumFractionDigits: 2 })} {symbol}
                    </span>
                  ) : (
                    <span className="text-mut">see wallet after fill</span>
                  )}
                </Row>
                <Row label="Router">
                  <span className="uppercase">{quote.router}</span>
                </Row>
                {quote.feeBps != null && (
                  <Row label="Jupiter fee">
                    <span className="tabular-nums">{(quote.feeBps / 100).toFixed(2)}%</span>
                  </Row>
                )}
              </div>
              <p className="font-mono text-[11px] leading-relaxed text-gold">
                Confirming signs this exact swap in your wallet. No auto-trading — every
                trade needs your explicit confirmation here.
              </p>
            </>
          )}
          {(phase === "quoting" || phase === "signing" || phase === "executing") && (
            <p className="font-mono text-xs text-gold" role="status">
              {phase === "quoting" && "Getting Jupiter quote…"}
              {phase === "signing" && "Sign the transaction in your wallet…"}
              {phase === "executing" && "Executing via Jupiter…"}
            </p>
          )}
          {phase === "done" && signature && (
            <div className="rounded-md border border-up/40 bg-up/10 p-3">
              <p className="font-mono text-xs font-semibold uppercase tracking-widest text-up">
                Swap confirmed
              </p>
              <a
                className="mt-1 block break-all font-mono text-[11px] text-gold hover:underline"
                href={`https://solscan.io/tx/${signature}`}
                target="_blank"
                rel="noreferrer"
              >
                solscan.io/tx/{signature.slice(0, 16)}…
              </a>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-4 font-mono text-xs text-down" role="alert">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={close} disabled={busy}>
          {phase === "done" || phase === "failed" ? "Close" : "Cancel"}
        </Button>
        {candidate && connected && (phase === "idle" || phase === "failed") && (
          <Button variant="success" onClick={getQuote} disabled={busy}>
            Get quote
          </Button>
        )}
        {phase === "quoted" && (
          <Button variant="success" onClick={confirmSwap} disabled={busy}>
            Confirm swap ${SIZE_USD}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
