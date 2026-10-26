import { useEffect } from "react";
import { LinkButton } from "../components/ui";

/** The two paths off this page. The replay is public; /app is where sign-in starts. */
const LINKS = {
  replay: "/?replay=phantom",
  live: "/app",
  repo: "https://github.com/SoroushRF/Rehearsal",
} as const;

/**
 * The shared focus rule paints a box-shadow, and these buttons already set one, which
 * covers it. This rule is more specific, so the same ring shows on keyboard focus.
 */
const FOCUS_CSS = `.landing-cta:focus-visible{box-shadow:var(--ring)}`;

/**
 * The front door. One sentence, the process, and two ways in.
 * Public and static: no sign-in, no API.
 */
export function Landing() {
  useEffect(() => {
    const before = document.title;
    document.title = "Rehearsal: change control for AI agents";
    return () => {
      document.title = before;
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#top"
        className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <style>{FOCUS_CSS}</style>
      <Header />
      <main
        id="top"
        className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-16 sm:px-6 sm:py-24"
      >
        <h1 className="max-w-xl text-[44px] leading-[0.98] font-extrabold text-ink [font-stretch:75%] sm:text-[68px]">
          Change control
          <br />
          for AI agents.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-ink">
          AI agents doing batch money operations need a dry run.
        </p>
        <PlanReadout />
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <LinkButton variant="secondary" size="lg" href={LINKS.replay} className="landing-cta">
            Watch a recorded run
          </LinkButton>
          <LinkButton variant="primary" size="lg" href={LINKS.live} className="landing-cta">
            Try it live
          </LinkButton>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-14 max-w-4xl items-center px-4 sm:px-6">
        <a href="/" className="flex items-baseline gap-2">
          <span className="brand-name">rehearsal</span>
          <span className="brand-tag">plan → apply</span>
        </a>
      </div>
    </header>
  );
}

/** The example plan, printed the way the product shows it: + adds, ~ changes. */
const READOUT: { op: "+" | "~"; kind: string; target: string; note: string; risk?: string }[] = [
  {
    op: "+",
    kind: "stripe.refund.create",
    target: "ch_fixture_001",
    note: "$42.10 CAD",
    risk: "compensable",
  },
  { op: "~", kind: "zendesk.ticket.patchFields", target: "#5531", note: "priority normal → high" },
  {
    op: "+",
    kind: "zendesk.ticket.appendPrivateNote",
    target: "#5531",
    note: "after refund_001",
    risk: "irreversible",
  },
  {
    op: "+",
    kind: "stripe.refund.create",
    target: "ch_fixture_002",
    note: "$125.00 CAD",
    risk: "compensable",
  },
  { op: "~", kind: "zendesk.ticket.patchFields", target: "#5532", note: "priority normal → high" },
  {
    op: "+",
    kind: "zendesk.ticket.appendPrivateNote",
    target: "#5532",
    note: "after refund_002",
    risk: "irreversible",
  },
];

function PlanReadout() {
  return (
    <figure className="mt-10" aria-label="An example plan for incident INC-BILL-0927">
      {/* Scrolls sideways on a phone, so it takes focus for keyboard scrolling. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable */}
      <pre className="plan-readout" tabIndex={0}>
        <span className="text-subtle">$ rehearsal plan INC-BILL-0927{"\n"}</span>
        <span className="text-subtle">
          Rehearsed in the planning world · 2 customer cases{"\n\n"}
        </span>
        {READOUT.map((r) => (
          <span key={`${r.kind}${r.target}`}>
            {"  "}
            <span className={r.op === "+" ? "text-ok" : "text-warn"}>{r.op}</span>{" "}
            {r.kind.padEnd(34)}
            {r.target.padEnd(17)}
            {r.note.padEnd(24)}
            {r.risk && (
              <span className={r.risk === "irreversible" ? "text-danger" : "text-warn"}>
                {r.risk}
              </span>
            )}
            {"\n"}
          </span>
        ))}
        {"\n"}Plan: <span className="text-ok">4 to add</span>,{" "}
        <span className="text-warn">2 to change</span>, 0 to destroy. Refunds{" "}
        <span className="font-semibold text-accent">$167.10 CAD</span>.{"\n"}
        Needs: finance lead, support lead. Apply waits for both signatures.
      </pre>
    </figure>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-8 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Built for Build North, October 2026</p>
        <a className="hover:text-ink hover:underline" href={LINKS.repo}>
          Source on GitHub
        </a>
      </div>
    </footer>
  );
}
