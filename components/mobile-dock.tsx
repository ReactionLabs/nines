"use client";

import { cn } from "@/lib/utils";

function CrosshairIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z" />
    </svg>
  );
}

function JournalIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4Z" />
      <path d="M4 20a2 2 0 0 1 2-2h13" />
      <path d="M9 7h7M9 11h5" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  );
}

function OctagonIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9L7.9 2Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function BriefcaseIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <path d="M2 13h20" />
    </svg>
  );
}

function DollarIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M12 2v20" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function NineIcon() {
  return (
    <span className="flex h-5 w-5 items-center justify-center font-mono text-lg font-bold leading-none">
      9
    </span>
  );
}

/**
 * Mobile bottom dock: core 5 tabs. The rest live in the side nav.
 * Active tab highlighted gold. Thumb-friendly tap targets.
 */
export function MobileDock({
  tab,
  onTabChange,
  alertsCount,
  unreadAlerts,
  watchlistCount,
}: {
  tab: string;
  onTabChange: (v: string) => void;
  alertsCount: number;
  unreadAlerts: number;
  watchlistCount: number;
}) {
  // Core 5: everything else lives in the side nav drawer.
  const tabs = [
    { value: "trenches", label: "Trenches", icon: <CrosshairIcon /> },
    { value: "nines", label: "Nines", icon: <NineIcon /> },
    { value: "smart-money", label: "Smart $", icon: <DollarIcon /> },
    {
      value: "watchlist",
      label: "Watchlist",
      icon: <StarIcon />,
      badge: watchlistCount > 0 ? watchlistCount : undefined,
    },
    { value: "journal", label: "Journal", icon: <JournalIcon /> },
  ];

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 backdrop-blur md:hidden"
    >
      <div
        className="flex snap-x gap-1 overflow-x-auto px-2 pt-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ paddingBottom: "calc(0.25rem + env(safe-area-inset-bottom))" }}
      >
        {tabs.map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              onClick={() => onTabChange(t.value)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex min-w-[64px] shrink-0 snap-start flex-col items-center gap-1 rounded-lg px-2 py-2 transition-colors",
                active ? "text-gold" : "text-mut active:text-white"
              )}
            >
              <span className="relative">
                {t.icon}
                {t.badge != null && (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 font-mono text-[9px] font-bold text-black">
                    {t.badge > 99 ? "99+" : t.badge}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "font-mono text-[10px] font-medium tracking-wide",
                  active && "font-bold"
                )}
              >
                {t.label}
              </span>
              {active && (
                <span className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-gold" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
