"use client";

import { ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import * as standardWallets from "@solana/wallet-adapter-wallets";
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";
import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import { JupiterInjectedWalletAdapter } from "./wallets/jupiter-injected";
import type { Adapter } from "@solana/wallet-adapter-base";

/**
 * Solana wallet adapter provider.
 *
 * Supports every Solana wallet:
 *  - All standard adapters from @solana/wallet-adapter-wallets
 *    (Phantom, Solflare, Coinbase, Ledger, Trust, Exodus via xdefi, etc.)
 *  - Backpack (separate package)
 *  - Jupiter (injected): inside Jupiter Mobile's dApp browser or any in-app
 *    browser that injects a Solana provider. No QR needed.
 *  - WalletConnect: pairs any WC-compatible phone wallet. Requires
 *    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID; skipped when unset.
 *  - Wallet Standard auto-detection: any wallet implementing the Solana
 *    Wallet Standard is picked up automatically by WalletProvider, even
 *    without an explicit adapter above.
 *
 * Login stays whitelist-only: the picker can show every wallet, but the
 * server grants sessions only to addresses in WALLET_ALLOWLIST. No open
 * registration.
 *
 * RPC endpoint: set NEXT_PUBLIC_SOLANA_RPC_URL (e.g. a Helius endpoint,
 * which allows browser CORS). Falls back to the public cluster URL, which
 * 403s balance fetches from browsers — always set the env var in production.
 *
 * Mainnet only. autoConnect is off: connecting a wallet never grants a
 * terminal session on its own — wallet-signature login is always required. The connected wallet is the user's self-custodial
 * trading wallet: signing happens in the wallet, keys never touch the app.
 */

// Adapters that must not be auto-instantiated.
const EXCLUDED_ADAPTERS = new Set([
  "WalletConnectWalletAdapter", // needs projectId config; added separately below
  "UnsafeBurnerWalletAdapter", // dev-only burner wallet; never in production
]);

function isAdapterClass(v: unknown): v is new () => Adapter {
  return (
    typeof v === "function" &&
    typeof (v as { name?: unknown }).name === "string" &&
    (v as { name: string }).name.endsWith("Adapter") &&
    !EXCLUDED_ADAPTERS.has((v as { name: string }).name)
  );
}

export function WalletAdapterProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(
    () =>
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      clusterApiUrl("mainnet-beta"),
    []
  );

  const wallets = useMemo(() => {
    const list: Adapter[] = [new JupiterInjectedWalletAdapter()];

    // Every standard adapter exported by @solana/wallet-adapter-wallets.
    // Adapters whose constructors need config are skipped safely.
    for (const exported of Object.values(standardWallets)) {
      if (!isAdapterClass(exported)) continue;
      try {
        list.push(new exported());
      } catch {
        // Adapter needs constructor config — skip, Wallet Standard
        // auto-detection may still pick the wallet up.
      }
    }

    // Backpack lives in its own package (not in the wallets bundle).
    try {
      list.push(new BackpackWalletAdapter());
    } catch {
      // ignore
    }

    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (projectId) {
      list.push(
        new WalletConnectWalletAdapter({
          network: WalletAdapterNetwork.Mainnet,
          options: {
            projectId,
            metadata: {
              name: "The Nines",
              description: "The Nines trading terminal. Watch every lamport.",
              url:
                typeof window !== "undefined"
                  ? window.location.origin
                  : "http://localhost:3000",
              icons: [
                `${
                  typeof window !== "undefined"
                    ? window.location.origin
                    : "http://localhost:3000"
                }/favicon.ico`,
              ],
            },
          },
        })
      );
    }
    return list;
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
