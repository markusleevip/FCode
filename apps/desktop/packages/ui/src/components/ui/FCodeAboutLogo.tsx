import fcodeIconUrl from "@/assets/fcode-icon.svg";
import fcodeLogoUrl from "@/assets/fcode-logo.svg";
import { cn } from "@/components/lib/utils.js";

export function FCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img
      src={fcodeIconUrl}
      className={cn("shrink-0", className)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function FCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <img
      src={fcodeLogoUrl}
      className={cn("h-auto w-[244px] shrink-0", className)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
