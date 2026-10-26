import { HealthResponse } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

/** Where a page puts its section tabs: the top bar, beside the wordmark. */
const TopNavSlot = createContext<HTMLElement | null>(null);

/** Renders its tabs into the top bar; inline when there is no bar (tests, other shells). */
export function TopNav({ children }: { children: ReactNode }) {
  const slot = useContext(TopNavSlot);
  return slot ? createPortal(children, slot) : children;
}

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
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-stretch justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-stretch gap-4 sm:gap-7">
            <a href="/" className="flex items-baseline gap-2 self-center">
              <span className="brand-name">rehearsal</span>
              <span className="brand-tag hidden sm:inline">plan → apply</span>
            </a>
            <div ref={setSlot} className="flex min-w-0 items-stretch" />
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
        <TopNavSlot.Provider value={slot}>{children}</TopNavSlot.Provider>
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

/** Text tabs with an ink underline, for switching between a handful of plans or replays. */
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
    `inline-flex h-8 items-center border-b-2 text-[13px] whitespace-nowrap transition-colors ${
      on ? "border-ink font-semibold text-ink" : "border-transparent text-muted hover:text-ink"
    }`;
  return (
    <nav aria-label={label} className="flex max-w-full gap-5 overflow-x-auto sm:inline-flex">
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
