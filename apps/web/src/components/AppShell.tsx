import { HealthResponse } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Icon } from "./ui";

/** Top bar and page frame shared by the review page and the saved-replay page. */
export function AppShell({
  account,
  nav,
  status = true,
  children,
}: {
  /** Sign-in controls, right-aligned. */
  account?: ReactNode;
  /** Page-level navigation shown under the bar, e.g. the plan or replay picker. */
  nav?: ReactNode;
  /** Show the API connection status. Off for pages that are static files and never call the API. */
  status?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <a href="/" className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-on-accent shadow-card">
                <Icon name="flask" className="h-[18px] w-[18px]" />
              </span>
              <span className="text-[17px] font-semibold tracking-tight text-ink">Rehearsal</span>
            </a>
            <span className="hidden border-l border-line pl-3 text-[13px] text-subtle md:inline">
              Rehearse the plan. Approve its effects. Apply with evidence.
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-3">{account}</div>
        </div>
        {nav && (
          <div className="border-t border-line/70">
            <div className="mx-auto max-w-6xl px-4 py-2 sm:px-6">{nav}</div>
          </div>
        )}
      </header>

      <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 text-xs text-subtle sm:px-6">
          <span>
            Plans are rehearsed in a copy of the company. Nothing reaches production until approved.
          </span>
          {status && <ApiStatus />}
        </div>
      </footer>
    </div>
  );
}

function ApiStatus() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => HealthResponse.parse(await (await fetch("/api/health")).json()),
    retry: false,
  });
  const state = health.isPending ? "checking" : health.isError ? "down" : "up";
  const dot = { checking: "bg-subtle/60", down: "bg-subtle/60", up: "bg-ok-solid" }[state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-testid="api-status">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {state === "checking" && "Checking API…"}
      {state === "down" && "API offline"}
      {state === "up" && `API connected · ${health.data?.mode} mode`}
    </span>
  );
}

/** A pill-shaped segmented picker for switching between a handful of plans or replays. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: { id: T; text: string; title?: string; href?: string }[];
  onChange?: (id: T) => void;
}) {
  const cls = (on: boolean) =>
    `inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
      on ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"
    }`;
  return (
    <nav
      aria-label={label}
      className="-mx-1 flex max-w-full gap-1 overflow-x-auto rounded-xl bg-sunken p-1 sm:inline-flex"
    >
      {options.map((o) =>
        o.href ? (
          <a
            key={o.id}
            href={o.href}
            title={o.title}
            aria-current={o.id === value ? "page" : undefined}
            className={cls(o.id === value)}
          >
            {o.text}
          </a>
        ) : (
          <button
            key={o.id}
            type="button"
            title={o.title}
            aria-current={o.id === value ? "page" : undefined}
            onClick={() => onChange?.(o.id)}
            className={cls(o.id === value)}
          >
            {o.text}
          </button>
        ),
      )}
    </nav>
  );
}
