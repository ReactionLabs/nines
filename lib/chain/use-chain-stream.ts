"use client";

import { useEffect, useState } from "react";
import { ChainSocket, type ChainStats } from "./helius-ws";

/**
 * Singleton browser chain socket. One per tab: every component shares the
 * same underlying WebSocket, so opening the trade tape, the new-mints feed
 * and the whale watcher costs one connection, not three.
 *
 * Returns null on the server or when NEXT_PUBLIC_SOLANA_RPC_URL is unset:
 * callers must degrade honestly (show "live tape unavailable").
 */

let singleton: ChainSocket | null = null;
let constructed = false;

export function getChainSocket(): ChainSocket | null {
  if (typeof window === "undefined") return null;
  if (!constructed) {
    constructed = true;
    const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    if (!rpc) return null;
    singleton = new ChainSocket(rpc);
    singleton.connect();
  }
  return singleton;
}

/** Live throughput stats for the connection indicator. Updates 1/s. */
export function useChainStats(): ChainStats {
  const [stats, setStats] = useState<ChainStats>({
    connected: false,
    msgPerSec: 0,
    receivedTotal: 0,
    subCount: 0,
    reconnects: 0,
    lastEventAt: null,
  });
  useEffect(() => {
    const sock = getChainSocket();
    if (!sock) return;
    return sock.onStats(setStats);
  }, []);
  return stats;
}
