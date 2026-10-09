"use client";

import { cn } from "@/lib/utils";

/** Star toggle shared by feed cards, nines rows, and the token drawer. */
export function WatchStar({
  watched,
  onToggle,
  className,
  size = "md",
}: {
  watched: boolean;
  onToggle: () => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <button
      type="button"
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "shrink-0 rounded p-1 transition-colors",
        watched
          ? "text-gold hover:text-gold/70"
          : "text-mut/50 hover:bg-raised hover:text-gold",
        className
      )}
    >
      <svg
        className={dims}
        viewBox="0 0 24 24"
        fill={watched ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </button>
  );
}
