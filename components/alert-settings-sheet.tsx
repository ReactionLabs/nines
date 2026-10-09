"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Sheet,
  SheetHeader,
  SheetTitle,
  SheetContent,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface WalletPref {
  label: string;
  enabled: boolean;
}

interface AlertPrefs {
  version: 1;
  updated_at: number;
  categories: { nines: boolean; watchlist: boolean; smartmoney: boolean };
  wallets: Record<string, WalletPref>;
  quiet_hours: { enabled: boolean; start: string; end: string; tz: string };
}

const CATEGORY_META: Array<{
  key: "nines" | "watchlist" | "smartmoney";
  title: string;
  desc: string;
}> = [
  {
    key: "nines",
    title: "9/9 gate passes",
    desc: "Coins that clear all nine gates",
  },
  {
    key: "watchlist",
    title: "Watched wallets",
    desc: "Buys by the signal wallets you follow",
  },
  {
    key: "smartmoney",
    title: "Smart money",
    desc: "Fresh high-win-rate wallet buys",
  },
];

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
        checked
          ? "border-gold/60 bg-gold/25"
          : "border-line bg-raised hover:border-mut/50"
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all",
          checked ? "left-[22px] bg-gold" : "left-[3px] bg-mut"
        )}
      />
    </button>
  );
}

function Row({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-bg px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="truncate font-mono text-[11px] text-mut">{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="pb-2 pt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-mut/70 first:pt-0">
      {children}
    </p>
  );
}

export function AlertSettingsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/alert-prefs", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        throw new Error(d.error ?? `load failed (${res.status})`);
      }
      setPrefs(d.prefs as AlertPrefs);
      setLive(d.live === true);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  function update(fn: (p: AlertPrefs) => AlertPrefs) {
    setPrefs((p) => (p ? fn(p) : p));
    setDirty(true);
    setSavedAt(null);
  }

  async function save() {
    if (!prefs || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/alert-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefs }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.ok) {
        // Keep the user's selections: do NOT revert local state.
        throw new Error(d?.error ?? `save failed (${res.status})`);
      }
      setPrefs(d.prefs as AlertPrefs);
      setDirty(false);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save settings");
    } finally {
      setSaving(false);
    }
  }

  const wallets = prefs ? Object.entries(prefs.wallets) : [];
  const qh = prefs?.quiet_hours;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetHeader>
        <div>
          <SheetTitle className="font-mono">
            <span className="text-gold">ALERT</span>{" "}
            <span className="text-white">SETTINGS</span>
          </SheetTitle>
          <p className="pt-1 font-mono text-[11px] text-mut">
            Owner only. Enforced by the alert cron before anything prints.
          </p>
        </div>
        <button
          onClick={() => onOpenChange(false)}
          aria-label="Close settings"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-bg font-mono text-lg leading-none text-mut transition-colors hover:text-white"
        >
          ×
        </button>
      </SheetHeader>

      <SheetContent>
        {loading && !prefs ? (
          <p className="font-mono text-sm text-mut">loading settings…</p>
        ) : prefs ? (
          <>
            <div className="flex items-center gap-2 pb-1">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[10px]",
                  live
                    ? "border-up/40 bg-up/10 text-up"
                    : "border-line bg-raised text-mut"
                )}
              >
                {live ? "LIVE" : "SNAPSHOT"}
              </span>
              {savedAt && !dirty && (
                <span className="font-mono text-[11px] text-up">
                  saved{" "}
                  {new Date(savedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              )}
              {dirty && (
                <span className="font-mono text-[11px] text-gold">
                  unsaved changes
                </span>
              )}
            </div>

            {error && (
              <p className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 font-mono text-xs text-down">
                {error}
              </p>
            )}

            <SectionTitle>Alert categories</SectionTitle>
            <div className="space-y-2">
              {CATEGORY_META.map((c) => (
                <Row
                  key={c.key}
                  title={c.title}
                  desc={c.desc}
                  checked={prefs.categories[c.key]}
                  onChange={(v) =>
                    update((p) => ({
                      ...p,
                      categories: { ...p.categories, [c.key]: v },
                    }))
                  }
                />
              ))}
            </div>

            <SectionTitle>Watched wallets</SectionTitle>
            <div className="space-y-2">
              {wallets.length === 0 && (
                <p className="font-mono text-xs text-mut">
                  no watched wallets configured
                </p>
              )}
              {wallets.map(([address, w]) => (
                <Row
                  key={address}
                  title={w.label}
                  desc={`${address.slice(0, 4)}…${address.slice(-4)}`}
                  checked={w.enabled}
                  onChange={(v) =>
                    update((p) => ({
                      ...p,
                      wallets: {
                        ...p.wallets,
                        [address]: { ...p.wallets[address], enabled: v },
                      },
                    }))
                  }
                />
              ))}
            </div>

            <SectionTitle>Quiet hours</SectionTitle>
            <div className="rounded-lg border border-line bg-bg px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">Mute alerts</p>
                  <p className="font-mono text-[11px] text-mut">
                    America/New_York · muted alerts are marked delivered
                  </p>
                </div>
                <Toggle
                  checked={qh?.enabled ?? false}
                  onChange={(v) =>
                    update((p) => ({
                      ...p,
                      quiet_hours: { ...p.quiet_hours, enabled: v },
                    }))
                  }
                  label="Mute alerts during quiet hours"
                />
              </div>
              {qh?.enabled && (
                <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-mut/70">
                      from
                    </span>
                    <input
                      type="time"
                      value={qh.start}
                      onChange={(e) =>
                        update((p) => ({
                          ...p,
                          quiet_hours: { ...p.quiet_hours, start: e.target.value },
                        }))
                      }
                      className="rounded-md border border-line bg-raised px-2 py-1.5 font-mono text-sm text-white [color-scheme:dark]"
                    />
                  </label>
                  <span className="pt-5 font-mono text-xs text-mut">→</span>
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-mut/70">
                      to
                    </span>
                    <input
                      type="time"
                      value={qh.end}
                      onChange={(e) =>
                        update((p) => ({
                          ...p,
                          quiet_hours: { ...p.quiet_hours, end: e.target.value },
                        }))
                      }
                      className="rounded-md border border-line bg-raised px-2 py-1.5 font-mono text-sm text-white [color-scheme:dark]"
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="sticky bottom-0 -mx-5 mt-6 border-t border-line bg-surface/95 px-5 py-4 backdrop-blur">
              <button
                onClick={save}
                disabled={!dirty || saving}
                className={cn(
                  "w-full rounded-lg border py-2.5 font-mono text-sm font-semibold transition-colors",
                  !dirty || saving
                    ? "cursor-not-allowed border-line bg-raised text-mut"
                    : "border-gold/60 bg-gold/20 text-gold hover:bg-gold/30"
                )}
              >
                {saving ? "saving…" : dirty ? "save changes" : "saved"}
              </button>
              <p className="pt-2 text-center font-mono text-[10px] text-mut/60">
                muted or toggled-off alerts are marked delivered, never queued
              </p>
            </div>
          </>
        ) : (
          error && (
            <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 font-mono text-xs text-down">
              {error}
            </p>
          )
        )}
      </SheetContent>
    </Sheet>
  );
}
