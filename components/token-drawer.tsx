"use client";

import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import type { Candidate, Role } from "@/lib/types";
import type { EnrichedToken } from "@/lib/dexscreener";
import { TokenDetail } from "@/components/token-detail";

/**
 * Quick-view drawer: TokenDetail in a slide-out sheet.
 * For the full page, see app/coin/[mint]/page.tsx.
 */
export function TokenDrawer({
  candidate,
  enriched,
  role,
  watched,
  onToggleWatch,
  onClose,
  onExecute,
}: {
  candidate: Candidate | null;
  enriched: EnrichedToken | null;
  role: Role;
  watched: boolean;
  onToggleWatch: () => void;
  onClose: () => void;
  onExecute: (c: Candidate) => void;
}) {
  return (
    <Sheet open={candidate !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <TokenDetail
          candidate={candidate}
          enriched={enriched}
          role={role}
          watched={watched}
          onToggleWatch={onToggleWatch}
          onExecute={onExecute}
        />
      </SheetContent>
    </Sheet>
  );
}
