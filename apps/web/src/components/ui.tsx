import { type ComponentProps, type ReactNode, useState } from "react";

/* ---------- Icons: one stroke style, decorative unless given a label ---------- */

const PATHS = {
  refund: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.6 9.3c-.5-.8-1.4-1.3-2.6-1.3-1.5 0-2.6.8-2.6 1.9 0 2.6 5.2 1.4 5.2 4 0 1.2-1.2 1.9-2.6 1.9-1.3 0-2.3-.5-2.8-1.4M12 6.4V8m0 8v1.6" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19.2 8.8a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M14 7l3 3" />
    </>
  ),
  note: (
    <>
      <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-8.2L6.5 21v-3.5H5A1.5 1.5 0 0 1 3.5 16V6A1.5 1.5 0 0 1 5 4.5z" />
      <path d="M8 9.5h8M8 13h5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h9.5a6 6 0 0 1 0 12H11" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 3v5.3c0 4.6-3.1 8.2-7.5 9.7-4.4-1.5-7.5-5.1-7.5-9.7V6L12 3z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: (
    <>
      <path d="M12 4l9.5 16.5h-19L12 4z" />
      <path d="M12 10v4.2M12 17.4v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.2M12 7.8v.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16" />
    </>
  ),
  hash: <path d="M5 9h14M5 15h14M10.5 4L8.5 20M15.5 4l-2 16" />,
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20c.4-3.4 3-5.5 6.5-5.5s6.1 2.1 6.5 5.5M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c1.9.7 3.2 2.4 3.5 5.2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  play: <path d="M8 5.5l10.5 6.5L8 18.5v-13z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3.5h5M10.5 3.5v6L5 19a1.5 1.5 0 0 0 1.3 2.2h11.4A1.5 1.5 0 0 0 19 19l-5.5-9.5v-6" />
      <path d="M7.5 15h9" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 9.5h18M3 14.5h18M8 4.5v15M16 4.5v15" />
    </>
  ),
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className = "h-4 w-4",
  label,
}: {
  name: IconName;
  className?: string;
  /** Only for an icon that carries meaning on its own; otherwise it is hidden from readers. */
  label?: string;
}) {
  const shared = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: `shrink-0 ${className}`,
  } as const;
  if (label) {
    return (
      <svg {...shared} role="img" aria-label={label}>
        <title>{label}</title>
        {PATHS[name]}
      </svg>
    );
  }
  return (
    <svg {...shared} aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`spin ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Buttons ---------- */

const VARIANT = {
  primary:
    "bg-accent text-on-accent shadow-card hover:bg-accent-hover active:translate-y-px border border-transparent",
  secondary:
    "bg-surface text-ink border border-line-strong shadow-card hover:bg-sunken active:translate-y-px",
  ghost: "text-muted hover:bg-sunken hover:text-ink border border-transparent",
  success:
    "bg-ok text-surface border border-transparent shadow-card hover:brightness-110 active:translate-y-px",
} as const;
const SIZE = { sm: "h-8 px-3 text-[13px] gap-1.5", md: "h-10 px-4 text-sm gap-2" } as const;

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading,
  className = "",
  children,
  disabled,
  ...rest
}: {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  icon?: IconName;
  loading?: boolean;
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-lg font-medium whitespace-nowrap transition-[background-color,box-shadow,transform,filter] duration-150 disabled:pointer-events-none disabled:opacity-50 ${SIZE[size]} ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/* ---------- Chips ---------- */

const TONE = {
  neutral: "bg-sunken text-muted border-line",
  good: "bg-ok-bg text-ok border-ok-line",
  warn: "bg-warn-bg text-warn border-warn-line",
  danger: "bg-danger-bg text-danger border-danger-line",
  info: "bg-info-bg text-info border-info-line",
  accent: "bg-accent-soft text-accent border-transparent",
} as const;
export type Tone = keyof typeof TONE;

export function Chip({
  tone = "neutral",
  icon,
  hint,
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={hint}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-5 font-medium whitespace-nowrap ${TONE[tone]}`}
    >
      {icon && <Icon name={icon} className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}

/* ---------- Surfaces ---------- */

export function Card({
  className = "",
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={`rounded-2xl border border-line bg-surface shadow-card ${className}`}
      {...rest}
    >
      {children}
    </section>
  );
}

const ALERT = {
  danger: { box: "bg-danger-bg border-danger-line text-danger", icon: "alert" },
  warn: { box: "bg-warn-bg border-warn-line text-warn", icon: "alert" },
  info: { box: "bg-info-bg border-info-line text-info", icon: "info" },
  good: { box: "bg-ok-bg border-ok-line text-ok", icon: "check" },
} as const;

export function Alert({
  tone = "danger",
  title,
  children,
  className = "",
  ...rest
}: {
  tone?: keyof typeof ALERT;
  title?: string;
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const a = ALERT[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex gap-3 rounded-xl border p-3.5 text-sm ${a.box} ${className}`}
      {...rest}
    >
      <Icon name={a.icon} className="mt-0.5 h-[18px] w-[18px]" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? "mt-0.5" : ""}>{children}</div>
      </div>
    </div>
  );
}

export const Skeleton = ({ className = "" }: { className?: string }) => (
  <div className={`skeleton ${className}`} aria-hidden />
);

/* ---------- Small helpers ---------- */

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          // Clipboard can be blocked (insecure origin, permissions); the full value is in the tooltip.
        }
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-subtle hover:bg-sunken hover:text-ink"
    >
      <Icon name={done ? "check" : "copy"} className="h-3.5 w-3.5" />
    </button>
  );
}

/** A labelled figure, for the summary panel. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-subtle uppercase">{label}</dt>
      <dd className="tnum mt-0.5 text-lg leading-6 font-semibold text-ink">{value}</dd>
      {hint && <dd className="text-xs text-subtle">{hint}</dd>}
    </div>
  );
}
