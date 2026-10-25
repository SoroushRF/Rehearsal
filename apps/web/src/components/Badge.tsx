import type { ReactNode } from "react";
import { Chip, type IconName, type Tone } from "./ui";

export type { Tone } from "./ui";

/** Kept for existing callers: the pill is the shared `Chip` now. */
export function Badge({
  tone,
  hint,
  icon,
  children,
}: {
  tone: Tone;
  hint?: string;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <Chip tone={tone} {...(hint && { hint })} {...(icon && { icon })}>
      {children}
    </Chip>
  );
}
