"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import bs58 from "bs58";
import { buildLoginMessage } from "@/lib/wallet-auth-client";

/**
 * Wallet-only login. There is no password path: the passphrase form and the
 * /api/login route were removed. A signed wallet message against
 * WALLET_ALLOWLIST is the only way to get a session.
 *
 * Non-whitelisted wallets land on a "not whitelisted" panel with an inline
 * request-access form. They never receive a session.
 */

interface WalletCard {
  /** Adapter name as registered in the wallet provider. */
  name: string;
  /** Mobile deep link opening the site inside the wallet app's browser. */
  deeplink?: (siteUrl: string) => string;
}

const WALLET_CARDS: WalletCard[] = [
  {
    name: "Phantom",
    deeplink: (u) =>
      `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(u)}`,
  },
  {
    name: "Solflare",
    deeplink: (u) =>
      `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(u)}`,
  },
  {
    name: "Backpack",
    deeplink: (u) =>
      `https://backpack.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(u)}`,
  },
  { name: "Jupiter" }, // works inside Jupiter Mobile's dApp browser
  { name: "WalletConnect" }, // pairs a phone wallet via QR (needs project ID)
];

type CardState = "installed" | "available" | "missing";

const STATE_LABEL: Record<CardState, string> = {
  installed: "Installed",
  available: "Detected",
  missing: "Not detected",
};

function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function siteUrl(): string {
  if (typeof window === "undefined") return "http://localhost:3000";
  return window.location.origin;
}

export default function LoginPage() {
  const { wallets, select, disconnect, connected } = useWallet();
  const [busy, setBusy] = useState<string | null>(null); // wallet name in flight
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deniedAddress, setDeniedAddress] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestDone, setRequestDone] = useState(false);
  const [mobile] = useState(isMobile);

  // If a wallet was left connected from a previous visit, drop it: wallet
  // connection alone must never look like a session.
  useEffect(() => {
    if (connected) disconnect().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = useMemo(
    () =>
      WALLET_CARDS.map((card) => {
        const entry = wallets.find((w) => w.adapter.name === card.name);
        if (!entry) return { ...card, entry: null, state: "missing" as CardState, icon: null as string | null };
        const state: CardState =
          entry.readyState === "Installed"
            ? "installed"
            : entry.readyState === "Loadable"
              ? "available"
              : "missing";
        return { ...card, entry, state, icon: (entry.adapter.icon as string) || null };
      }).filter((c) => c.name !== "WalletConnect" || c.entry), // WC card only when configured
    [wallets]
  );

  async function loginWith(name: string) {
    const card = cards.find((c) => c.name === name);
    if (!card?.entry || busy) return;
    const adapter = card.entry.adapter as unknown as {
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      publicKey: { toBase58(): string } | null;
      signMessage?(message: Uint8Array): Promise<Uint8Array>;
    };
    setBusy(name);
    setError(null);
    setDeniedAddress(null);
    setRequestDone(false);
    try {
      setStep("Connecting wallet…");
      select(name as WalletName);
      await adapter.connect();
      const address = adapter.publicKey?.toBase58();
      if (!address) throw new Error("Wallet connected but returned no address.");

      setStep("Sign the login message in your wallet…");
      if (typeof adapter.signMessage !== "function") {
        throw new Error("This wallet cannot sign messages.");
      }
      const message = buildLoginMessage(address, new Date().toISOString());
      const sig = await adapter.signMessage(new TextEncoder().encode(message));
      if (!sig) throw new Error("Wallet did not return a signature.");

      setStep("Verifying…");
      const res = await fetch("/api/auth/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, message, signature: bs58.encode(sig) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        // Full reload: client-side navigation does not reliably send the
        // just-set session cookies through middleware, which bounces back
        // to /login. A hard navigation fixes it.
        window.location.href = "/";
        return;
      }
      if (res.status === 401 && /not authorized/i.test(data.error ?? "")) {
        setDeniedAddress(address);
      } else {
        setError(data.error ?? "Wallet login failed.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Wallet login failed.";
      setError(
        /not installed|not detected|not found/i.test(msg)
          ? `${name} is not installed in this browser.`
          : msg
      );
    } finally {
      try {
        await adapter.disconnect();
      } catch {
        // ignore
      }
      setBusy(null);
      setStep(null);
    }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!deniedAddress || requestBusy) return;
    setRequestBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: deniedAddress, note }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setRequestDone(true);
      } else {
        setError(data.error ?? "Could not queue your request. Try again.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setRequestBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-4 py-10">
      {/* ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(600px 320px at 50% -60px, rgba(231,184,75,0.14), transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-md">
        {/* chrome 9 mascot */}
        <div className="mb-6 text-center">
          <div
            aria-hidden="true"
            className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-line bg-surface shadow-[0_0_50px_-10px_rgba(231,184,75,0.35)]"
          >
            <span
              className="bg-[linear-gradient(180deg,#ffffff_0%,#cfd6dd_28%,#7d8590_48%,#eef1f5_52%,#9aa2ad_72%,#f7f9fb_100%)] bg-clip-text font-mono text-6xl font-bold leading-none text-transparent"
              style={{ textShadow: "0 2px 12px rgba(0,0,0,0.45)" }}
            >
              9
            </span>
          </div>
          <div className="mt-4 font-mono text-2xl font-semibold tracking-tight">
            <span className="text-gold">THE</span>
            <span className="text-white"> NINES</span>
          </div>
          <p className="mt-2 font-mono text-xs uppercase tracking-widest text-mut">
            Private terminal
          </p>
          <p className="mt-1 text-sm text-mut">
            Whitelisted wallets only. Connect yours to enter.
          </p>
        </div>

        {/* branded wallet cards */}
        <div className="space-y-2.5">
          {cards.map((card) => {
            const active = busy === card.name;
            return (
              <div key={card.name}>
                <button
                  onClick={() => loginWith(card.name)}
                  disabled={!!busy}
                  className="group flex w-full items-center gap-4 rounded-xl border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:border-gold/60 hover:bg-raised disabled:cursor-wait disabled:opacity-60"
                >
                  {card.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={card.icon}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded-lg"
                    />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-raised font-mono text-sm font-bold text-gold">
                      {card.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-white">{card.name}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          card.state === "installed"
                            ? "bg-up"
                            : card.state === "available"
                              ? "bg-gold"
                              : "bg-mut/50"
                        }`}
                      />
                      <span className="font-mono text-[11px] uppercase tracking-wider text-mut">
                        {STATE_LABEL[card.state]}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-gold opacity-0 transition-opacity group-hover:opacity-100">
                    {active ? "Waiting…" : "Connect →"}
                  </span>
                </button>
                {mobile && card.state !== "installed" && card.deeplink && (
                  <a
                    href={card.deeplink(siteUrl())}
                    className="mt-1.5 block text-center font-mono text-[11px] text-info hover:text-white"
                  >
                    Open in {card.name} app
                  </a>
                )}
              </div>
            );
          })}
        </div>

        {step && (
          <p className="mt-4 text-center font-mono text-xs text-gold">{step}</p>
        )}
        {error && (
          <p className="mt-4 text-center font-mono text-xs text-down" role="alert">
            {error}
          </p>
        )}

        {/* not-whitelisted state with inline request-access form */}
        {deniedAddress && (
          <div className="mt-6 rounded-xl border border-gold/50 bg-surface p-5">
            <div className="font-mono text-xs font-semibold uppercase tracking-widest text-gold">
              Wallet not whitelisted
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-mut">
              {deniedAddress}
            </p>
            <p className="mt-3 text-sm text-mut">
              This terminal is private. Your wallet is not on the access list,
              so no session was created.
            </p>
            {requestDone ? (
              <p className="mt-4 rounded-lg border border-up/40 bg-bg p-3 font-mono text-xs text-up">
                Request received. You will be notified if approved.
              </p>
            ) : (
              <form onSubmit={submitRequest} className="mt-4 space-y-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="access-note"
                    className="font-mono text-[11px] uppercase tracking-widest text-mut"
                  >
                    Note (optional, who you are, why you want in)
                  </label>
                  <input
                    id="access-note"
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    placeholder="Name, how you know Dip…"
                    disabled={requestBusy}
                    className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-white outline-none placeholder:text-mut/50 focus:border-gold/60"
                  />
                </div>
                <button
                  type="submit"
                  disabled={requestBusy}
                  className="w-full rounded-md bg-gold px-4 py-2.5 font-mono text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {requestBusy ? "Sending…" : "Request access"}
                </button>
              </form>
            )}
          </div>
        )}

        <p className="mt-6 text-center font-mono text-[11px] leading-relaxed text-mut/60">
          Your wallet signs a login message. Nothing is sent except the
          signature.
          <br />
          No account signup exists. Access is by whitelist only.
        </p>
      </div>
    </div>
  );
}
