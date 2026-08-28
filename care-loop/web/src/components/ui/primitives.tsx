// Care UI publishes these as a shadcn registry, but its endpoints currently serve the docs SPA's
// HTML instead of registry JSON, so `shadcn add` fails on `Unexpected token '<'`. Written against the
// same token names Care UI's components consume, so the real ones can replace this file unchanged.

import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
  "transition-colors disabled:pointer-events-none disabled:opacity-50";

const VARIANTS = {
  default: "bg-primary text-primary-foreground hover:opacity-90",
  outline: "border border-border bg-background hover:bg-muted",
  ghost: "hover:bg-muted",
  link: "text-primary underline-offset-4 hover:underline p-0 h-auto",
} as const;

const SIZES = { sm: "h-8 px-3", md: "h-9 px-4", none: "" } as const;

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}) {
  return <button className={cn(BUTTON_BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm",
        "placeholder:text-muted-foreground/70 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  // Native rather than a listbox widget: keyboard- and screen-reader-correct for free, and the
  // platform picker on mobile. These options are plain strings with counts.
  return (
    <select
      className={cn(
        "h-9 rounded-md border border-input bg-background px-2 text-sm max-w-[14rem]",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "live" | "warn" | "danger" }) {
  const tones = {
    neutral: "border-border bg-muted text-muted-foreground",
    live: "border-live/40 bg-live/10 text-live",
    warn: "border-warn/40 bg-warn/10 text-warn",
    danger: "border-destructive/40 bg-destructive/10 text-destructive",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}
