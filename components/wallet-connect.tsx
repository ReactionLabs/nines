"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { cn } from "@/lib/utils";

/**
 * Wallet connect button (ported from dipops-terminal, restyled to the
 * Nines dark theme). Read-only for now — portfolio viewing.
 */
export function WalletConnectButton({ className }: { className?: string }) {
  const {
    publicKey,
    connected,
    connecting,
    disconnecting,
    connect,
    disconnect,
    wallets,
    select,
  } = useWallet();
  const [selected, setSelected] = useState<WalletName | "">("");

  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const available = useMemo(
    () =>
      wallets.filter(
        (w) => w.readyState === "Installed" || w.readyState === "Loadable"
      ),
    [wallets]
  );

  const onConnect = async () => {
    if (selected) select(selected as WalletName);
    await connect();
  };

  if (connected && address) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5",
          className
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-up" />
        <span className="font-mono text-[11px] text-white">
          {address.slice(0, 4)}…{address.slice(-4)}
        </span>
        <button
          className="font-mono text-[11px] text-mut hover:text-down"
          disabled={disconnecting}
          onClick={() => disconnect()}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5",
        className
      )}
    >
      <select
        className="bg-transparent font-mono text-[11px] text-mut outline-none"
        value={selected}
        onChange={(e) => setSelected(e.target.value as WalletName)}
        aria-label="Select wallet"
      >
        <option value="">Wallet</option>
        {available.map((w) => (
          <option key={w.adapter.name} value={w.adapter.name}>
            {w.adapter.name}
          </option>
        ))}
      </select>
      <button
        className="font-mono text-[11px] font-medium text-gold hover:text-white disabled:opacity-50"
        disabled={connecting}
        onClick={onConnect}
      >
        {connecting ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}
