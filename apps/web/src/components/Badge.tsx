import type { ReactNode } from "react";

const tones = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warn: "bg-amber-50 text-amber-900 ring-amber-200",
  danger: "bg-rose-50 text-rose-800 ring-rose-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
} as const;
export type Tone = keyof typeof tones;

export function Badge({
  tone,
  hint,
  children,
}: {
  tone: Tone;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={hint}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
