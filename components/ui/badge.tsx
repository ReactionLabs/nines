import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "border-line bg-raised text-mut",
        gold: "border-gold/40 bg-gold/10 text-gold",
        green: "border-up/40 bg-up/10 text-up",
        red: "border-down/40 bg-down/10 text-down",
        blue: "border-info/40 bg-info/10 text-info",
        gray: "border-line bg-surface text-mut",
        outline: "border-line text-mut",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
