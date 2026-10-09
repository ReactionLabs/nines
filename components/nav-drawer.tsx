"use client";

import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/types";
import { cn } from "@/lib/utils";
import { WalletConnectButton } from "@/components/wallet-connect";

const NAV_ITEMS = [
  { id: "trenches", label: "Trenches", icon: "◈" },
  { id: "nines", label: "The Nines", icon: "9" },
  { id: "alerts", label: "Alerts", icon: "🔔" },
  { id: "smart-money", label: "Smart Money", icon: "$" },
  { id: "watched", label: "Watched", icon: "👁" },
  { id: "watchlist", label: "Watchlist", icon: "★" },
  { id: "journal", label: "Journal", icon: "📓" },
  { id: "pnl", label: "PnL", icon: "📈" },
  { id: "stop-test", label: "Stop-test", icon: "🧪" },
  { id: "portfolio", label: "Portfolio", icon: "💼" },
] as const;

/**
 * Slide-in navigation drawer: full app navigation + account surface.
 */
export function NavDrawer({
  open,
  onClose,
  role,
  onSignOut,
  activeTab,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  role: Role;
  onSignOut: () => void;
  activeTab: string;
  onNavigate: (tab: string) => void;
}) {
  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open ]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  return (
    <div
      className={cn("fixed inset-0 z-50", !open && "pointer-events-none")}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0"
        )}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className={cn(
          "absolute left-0 top-0 flex h-full w-[280px] flex-col border-r border-line bg-bg shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <span className="font-mono text-sm font-bold tracking-tight">
            <span className="text-gold">THE</span>
            <span className="text-white"> NINES</span>
          </span>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface font-mono text-lg leading-none text-mut transition-colors hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <p className="pb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-mut/70">
            Navigate
          </p>
          <nav className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 font-mono text-[13px] transition-colors",
                  activeTab === item.id
                    ? "bg-gold/15 text-gold"
                    : "text-mut hover:bg-raised hover:text-white"
                )}
              >
                <span className="w-5 text-center text-[15px]">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <p className="pb-3 pt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-mut/70">
            Account
          </p>
          <WalletConnectButton className="w-full justify-center" />
        </div>

        <div className="border-t border-line px-4 py-4">
          <div className="flex items-center justify-between">
            <Badge variant={role === "dip" ? "gold" : "blue"}>
              {role === "dip" ? "OWNER" : "VIEWER"}
            </Badge>
            <button
              className="font-mono text-xs text-mut transition-colors hover:text-white"
              onClick={onSignOut}
            >
              sign out
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
