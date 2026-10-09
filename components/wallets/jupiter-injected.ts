"use client";

/* Jupiter injected wallet adapter.
 *
 * Covers path (a): when Lamport Terminal is opened inside a mobile wallet's
 * dApp browser (Jupiter Mobile or any in-app browser that injects a Solana
 * provider), this adapter wraps the injected provider directly — no QR code,
 * no deeplink round-trip.
 *
 * Provider detection order: window.jupiter.solana, then window.solana.
 * Signing (messages and transactions) happens inside the hosting wallet app;
 * private keys never leave the wallet.
 */

import {
  BaseMessageSignerWalletAdapter,
  WalletError,
  WalletReadyState,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

export const JUPITER_WALLET_NAME = "Jupiter" as WalletName;

// Minimal surface of an injected Solana provider (window.solana shape).
interface InjectedSolanaProvider {
  publicKey?: { toBase58(): string; toBytes(): Uint8Array } | null;
  isConnected?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  off?(event: string, cb: (...args: unknown[]) => void): void;
}

function getInjectedProvider(): InjectedSolanaProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const jupiter = w.jupiter as { solana?: InjectedSolanaProvider } | undefined;
  if (jupiter?.solana) return jupiter.solana;
  const solana = w.solana as InjectedSolanaProvider | undefined;
  return solana ?? null;
}

// Gold "J" mark on dark, as a data URI so the adapter needs no network fetch.
const JUPITER_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0c10"/><text x="32" y="44" font-family="monospace" font-size="36" font-weight="bold" fill="#f0b90b" text-anchor="middle">J</text></svg>`
  );

export class JupiterInjectedWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = JUPITER_WALLET_NAME;
  url = "https://jup.ag";
  icon = JUPITER_ICON;
  readonly supportedTransactionVersions = null;

  private _provider: InjectedSolanaProvider | null = null;
  private _publicKey: PublicKey | null = null;
  private _connecting = false;

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get connected(): boolean {
    return !!this._publicKey;
  }

  get readyState(): WalletReadyState {
    if (typeof window === "undefined") return WalletReadyState.Unsupported;
    return getInjectedProvider() ? WalletReadyState.Installed : WalletReadyState.NotDetected;
  }

  private handleDisconnect = () => {
    this._publicKey = null;
    this.emit("disconnect");
  };

  async connect(): Promise<void> {
    if (this.connected || this._connecting) return;
    const provider = getInjectedProvider();
    if (!provider) throw new Error("No injected Jupiter wallet found.");
    this._connecting = true;
    try {
      const res = await provider.connect();
      const address = res?.publicKey?.toString() ?? provider.publicKey?.toBase58();
      if (!address) throw new Error("Injected wallet returned no public key.");
      this._provider = provider;
      this._publicKey = new PublicKey(address);
      provider.on?.("disconnect", this.handleDisconnect);
      this.emit("connect", this._publicKey);
    } catch (e) {
      this.emit("error", new WalletError(e instanceof Error ? e.message : String(e), e));
      throw e;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    const provider = this._provider;
    this._provider = null;
    this._publicKey = null;
    provider?.off?.("disconnect", this.handleDisconnect);
    try {
      await provider?.disconnect();
    } catch {
      // ignore — we already dropped local state
    }
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    const provider = this._provider;
    if (!provider) throw new Error("Wallet not connected.");
    return provider.signTransaction(transaction);
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> {
    const provider = this._provider;
    if (!provider) throw new Error("Wallet not connected.");
    return provider.signAllTransactions(transactions);
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const provider = this._provider;
    if (!provider) throw new Error("Wallet not connected.");
    const res = await provider.signMessage(message);
    return res.signature;
  }
}
