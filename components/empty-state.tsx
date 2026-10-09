"use client";

import { cn } from "@/lib/utils";

function TerminalGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-10 w-10 text-mut/50", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M12 15h5" />
    </svg>
  );
}

/**
 * Intentional empty state: states what lives here, why it's empty,
 * and when to expect content. Never a bare "nothing here".
 */
export function EmptyState({
  title,
  body,
  hint,
  className,
}: {
  title: string;
  body: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface px-6 py-14 text-center",
        className
      )}
    >
      <TerminalGlyph />
      <p className="font-mono text-sm font-semibold uppercase tracking-widest text-white">
        {title}
      </p>
      <p className="max-w-md text-sm text-mut">{body}</p>
      {hint && (
        <p className="max-w-md font-mono text-[11px] text-mut/70">{hint}</p>
      )}
    </div>
  );
}
