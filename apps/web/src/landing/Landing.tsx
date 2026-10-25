import { type ReactNode, useEffect } from "react";
import { Card, Chip, Icon, type IconName, LinkButton } from "../components/ui";

/** Where each call to action goes. The app lives at /app; replays and example plans keep their links. */
const LINKS = {
  app: "/app",
  examplePlan: "/app?bundle=happy-path",
  teammatePlan: "/app?bundle=teammate-conflict",
  lostResponsePlan: "/app?bundle=unknown-outcome",
  replay: "/?replay=phantom",
  repo: "https://github.com/SoroushRF/Rehearsal",
} as const;

const NAV = [
  { href: "#how", text: "How it works" },
  { href: "#moments", text: "Moments" },
  { href: "#guarantees", text: "Guarantees" },
  { href: "#honest", text: "What's real" },
] as const;

/**
 * The front door: what Rehearsal is, why it exists, how it works and what it will and won't do.
 * Public and static: no sign-in, no API. Every claim here is something the code or its tests do.
 */
export function Landing() {
  useEffect(() => {
    const before = document.title;
    document.title = "Rehearsal: terraform plan for AI agents";
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
      <Header />
      <main id="top" className="flex-1">
        <Hero />
        <Problem />
        <HowItWorks />
        <Moments />
        <Guarantees />
        <Honest />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

/* ---------- Shell ---------- */

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="brand-name">Rehearsal</span>
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:bg-sunken hover:text-ink"
            >
              {n.text}
            </a>
          ))}
        </nav>
        <LinkButton variant="primary" size="sm" href={LINKS.app} trailingIcon="arrow">
          Open the app
        </LinkButton>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <span className="brand-mark">
      <Icon name="flask" className="h-[18px] w-[18px]" />
    </span>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="flex items-center gap-2.5">
          <Logo />
          <span>
            <span className="font-semibold text-ink">Rehearsal</span> · built for Build North,
            October 2026
          </span>
        </p>
        <p className="flex flex-wrap gap-x-5 gap-y-1">
          <a className="hover:text-ink hover:underline" href={LINKS.app}>
            Open the app
          </a>
          <a className="hover:text-ink hover:underline" href={LINKS.replay}>
            Saved replay
          </a>
          <a className="hover:text-ink hover:underline" href={LINKS.repo}>
            Source on GitHub
          </a>
        </p>
      </div>
    </footer>
  );
}

/* ---------- Sections ---------- */

const SECTION = "mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 sm:py-24";

function Heading({
  id,
  eyebrow,
  children,
  lead,
}: {
  id: string;
  eyebrow: string;
  children: ReactNode;
  lead?: ReactNode;
}) {
  return (
    <div className="max-w-2xl">
      <p className="workspace-label !text-accent">{eyebrow}</p>
      <h2
        id={id}
        className="mt-2 text-[28px] leading-9 font-semibold tracking-tight text-ink sm:text-4xl sm:leading-[2.75rem]"
      >
        {children}
      </h2>
      {lead && <p className="mt-4 text-base leading-7 text-muted sm:text-lg">{lead}</p>}
    </div>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero" className="relative overflow-hidden border-b border-line">
      {/* Soft color wash behind the headline; decorative only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(48rem_26rem_at_12%_-12%,var(--accent-soft),transparent_70%),repeating-linear-gradient(0deg,transparent_0_39px,color-mix(in_srgb,var(--line)_55%,transparent)_39px_40px)]"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
        <div>
          <Chip tone="accent" icon="flask">
            Tested on Stripe and Zendesk simulators
          </Chip>
          <h1
            id="hero"
            className="mt-5 text-[40px] leading-[1.08] font-semibold tracking-tight text-ink sm:text-6xl"
          >
            Terraform plan
            <br />
            for <span className="mark">AI agents</span>.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-muted">
            When an agent has to change real systems in bulk, it shouldn't touch them until a person
            has seen exactly what it will do. Rehearsal lets the agent decide inside a copy of the
            company, asks a human to approve the resulting plan once, then applies exactly that plan
            to production with no model in the loop.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <LinkButton variant="primary" size="lg" href={LINKS.examplePlan} trailingIcon="arrow">
              Open the example plan
            </LinkButton>
            <LinkButton variant="secondary" size="lg" href={LINKS.replay} icon="film">
              Watch a saved replay
            </LinkButton>
          </div>
          <p className="mt-4 text-sm text-subtle">
            No sign-in needed for either. Both are labelled as fixtures.
          </p>
        </div>
        <HeroPlan />
      </div>
    </section>
  );
}

/** A small, static picture of the review page, built from the same pieces as the real one. */
function HeroPlan() {
  return (
    <figure className="relative">
      <Card className="overflow-hidden shadow-raised">
        <div className="flex items-center justify-between gap-4 border-b border-line bg-sunken/60 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-subtle shadow-card ring-1 ring-line">
              <Icon name="users" className="h-[18px] w-[18px]" />
            </span>
            <div>
              <p className="text-[15px] leading-5 font-semibold text-ink">cus_fixture_001</p>
              <p className="text-xs text-subtle">3 steps</p>
            </div>
          </div>
          <p className="tnum text-lg font-semibold text-ink">$42.10 CAD</p>
        </div>
        <ul className="divide-y divide-line">
          <PlanLine
            icon="refund"
            tile="bg-accent-soft text-accent"
            title="Refund the customer"
            detail="Duplicate September charge"
            amount="$42.10 CAD"
            chips={
              <Chip tone="warn" icon="refund">
                Compensable
              </Chip>
            }
          />
          <PlanLine
            icon="edit"
            tile="bg-info-bg text-info"
            title="Raise ticket priority"
            detail="Priority normal → high"
            chips={
              <Chip tone="good" icon="undo">
                Reversible if unchanged
              </Chip>
            }
          />
          <PlanLine
            icon="note"
            tile="bg-sunken text-muted"
            title="Add a private note"
            detail="Records the confirmed refund"
            chips={
              <>
                <Chip tone="danger" icon="lock">
                  Irreversible
                </Chip>
                <Chip tone="accent" icon="arrow">
                  After the refund
                </Chip>
              </>
            }
          />
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sunken/40 px-5 py-3.5 text-sm">
          <span className="flex items-center gap-2 text-muted">
            <Icon name="shield" className="h-4 w-4 text-accent" />
            Needs a finance lead to approve
          </span>
          <code className="rounded-md bg-sunken px-2 py-1 font-mono text-[13px] text-ink">
            4a12c7884ef2…
          </code>
        </div>
      </Card>
      <figcaption className="mt-3 text-center text-xs text-subtle">
        An excerpt of the example plan. The hash is what an approval binds to.
      </figcaption>
    </figure>
  );
}

function PlanLine({
  icon,
  tile,
  title,
  detail,
  amount,
  chips,
}: {
  icon: IconName;
  tile: string;
  title: string;
  detail: string;
  amount?: string;
  chips: ReactNode;
}) {
  return (
    <li className="flex gap-3.5 px-5 py-4">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tile}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[15px] leading-6 font-semibold text-ink">{title}</p>
            <p className="text-[13px] leading-5 text-subtle">{detail}</p>
          </div>
          {amount && <p className="tnum shrink-0 text-base font-semibold text-ink">{amount}</p>}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">{chips}</div>
      </div>
    </li>
  );
}

function Problem() {
  const items: { icon: IconName; title: string; text: string }[] = [
    {
      icon: "users",
      title: "Approve every call",
      text: "Asks a person dozens of times per run with no view of the whole job. Approval fatigue is itself a safety problem.",
    },
    {
      icon: "undo",
      title: "Clean up afterwards",
      text: "Rolling back can't unsend a message, and restoring a snapshot can wipe legitimate edits made since.",
    },
    {
      icon: "flask",
      title: "Test it in general",
      text: "Offline evals show an agent is good in general, not that this particular run is safe.",
    },
  ];
  return (
    <section aria-labelledby="problem" className="border-b border-line bg-sunken/50">
      <div className={SECTION}>
        <Heading
          id="problem"
          eyebrow="The problem"
          lead="Agents that write to production systems fail in ways no one reviews until it is too late, and today's answers each leave a gap."
        >
          Deciding and doing shouldn't happen in the same step
        </Heading>

        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {items.map((it) => (
            <li key={it.title}>
              <Card className="h-full p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sunken text-muted">
                  <Icon name={it.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-ink">{it.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-muted">{it.text}</p>
              </Card>
            </li>
          ))}
        </ul>

        <figure className="mt-10 grid gap-6 rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8 lg:grid-cols-2 lg:gap-10">
          <blockquote>
            <p className="text-xs font-semibold tracking-wider text-subtle uppercase">
              In the wild: PocketOS, April 2026
            </p>
            <p className="mt-2 text-base leading-7 text-ink">
              A coding agent on a staging task used a broadly scoped Railway token to delete the
              production database and its volume backups in seconds. Railway restored off-site
              backups within about 30 minutes of being contacted; the founder reported about 30
              hours of disruption overall.
            </p>
          </blockquote>
          <blockquote>
            <p className="text-xs font-semibold tracking-wider text-subtle uppercase">
              By the numbers: Georgian, Wave 3 benchmark
            </p>
            <p className="mt-2 text-base leading-7 text-ink">
              Of 252 technical decision makers at B2B software companies, 55% had an AI incident in
              the last 12 months. 75% use human approval gates, and only 29% use policy-as-code.
            </p>
          </blockquote>
          <figcaption className="text-xs text-subtle lg:col-span-2">
            Both are cited from the project brief; follow the original sources before you rely on
            them.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps: { n: number; title: string; text: string; points: string[] }[] = [
    {
      n: 1,
      title: "Rehearse in a copy",
      text: "The agent plans against a copy of the company, never the real thing.",
      points: [
        "Every read is recorded with a fingerprint and the query behind it.",
        "What it wants to change is recorded as a typed step, not done.",
      ],
    },
    {
      n: 2,
      title: "Approve once",
      text: "A person sees the whole job on one page and signs it off once.",
      points: [
        "Grouped by customer, with money, what can be undone, and the evidence.",
        "Uncheck a customer and their dependent note drops with them.",
        "Refunds over the threshold need the finance role.",
      ],
    },
    {
      n: 3,
      title: "Apply deterministically",
      text: "A separate executor with no model applies exactly the approved plan.",
      points: [
        "Before each step it re-reads what the step relied on, and holds anything that changed.",
        "Every step ends in a receipt: the reason, the plan hash, the approver, the outcome.",
      ],
    },
  ];
  return (
    <section id="how" aria-labelledby="how-h" className="scroll-mt-20 border-b border-line">
      <div className={SECTION}>
        <Heading
          id="how-h"
          eyebrow="How it works"
          lead="The model decides inside a fork. Production only ever sees a recorded, approved plan."
        >
          Plan in a copy, approve once, apply with no model
        </Heading>

        <ol className="mt-10 grid gap-4 lg:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n}>
              <Card className="h-full p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-on-accent">
                    {s.n}
                  </span>
                  <h3 className="text-lg font-semibold text-ink">{s.title}</h3>
                </div>
                <p className="mt-3 text-sm leading-6 text-ink">{s.text}</p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-muted">
                  {s.points.map((p) => (
                    <li key={p} className="flex gap-2.5">
                      <Icon name="check" className="mt-1 h-4 w-4 text-ok" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ol>

        <WorldsDiagram />
      </div>
    </section>
  );
}

/** Two worlds and the gate between them: the one picture of the idea. */
function WorldsDiagram() {
  return (
    <figure
      aria-label="Diagram: the agent works in a planning world; only an approved plan reaches the operational world"
      className="m-0 mt-6 grid items-stretch gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6 md:grid-cols-[1fr_auto_1fr]"
    >
      <World
        tone="bg-accent-soft text-accent"
        title="Planning world"
        sub="A copy of the company"
        lines={[
          "The agent reads and plans here",
          "It holds the model key",
          "It never sees production",
        ]}
      />
      <div className="flex items-center justify-center gap-2 text-center md:flex-col">
        <Icon name="arrow" className="h-5 w-5 rotate-90 text-subtle md:rotate-0" />
        <span className="rounded-lg border border-line-strong bg-sunken px-3 py-2 text-xs leading-4 font-semibold text-ink">
          <Icon name="hash" className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          Approved plan hash
        </span>
        <Icon name="arrow" className="h-5 w-5 rotate-90 text-subtle md:rotate-0" />
      </div>
      <World
        tone="bg-ok-bg text-ok"
        title="Operational world"
        sub="Production"
        lines={[
          "Only the approved plan is applied",
          "No model, no model key",
          "Stale steps are held, not forced",
        ]}
      />
    </figure>
  );
}

function World({
  tone,
  title,
  sub,
  lines,
}: {
  tone: string;
  title: string;
  sub: string;
  lines: string[];
}) {
  return (
    <div className="rounded-xl border border-line p-5">
      <p className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
        {title}
      </p>
      <p className="mt-2 text-sm font-semibold text-ink">{sub}</p>
      <ul className="mt-2 space-y-1 text-sm leading-6 text-muted">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function Moments() {
  const moments: {
    icon: IconName;
    title: string;
    text: string;
    tone: string;
    cta: { href: string; text: string };
  }[] = [
    {
      icon: "alert",
      title: "The phantom",
      tone: "bg-warn-bg text-warn",
      text: "After approval, a new duplicate charge appears for a customer. Re-running the step's query catches it: that refund is held, its note is skipped, and every other customer's steps still apply.",
      cta: { href: LINKS.replay, text: "Open the saved replay" },
    },
    {
      icon: "shield",
      title: "A teammate's edit survives",
      tone: "bg-info-bg text-info",
      text: "If someone changes a ticket field by hand while a plan is applying, the executor won't overwrite it. It only reverts a field that still holds the value it wrote, and says so when it doesn't.",
      cta: { href: LINKS.teammatePlan, text: "See the example plan" },
    },
    {
      icon: "clock",
      title: "A lost response",
      tone: "bg-sunken text-muted",
      text: "A refund commits but its response never arrives. The executor reconciles by reading, never by blindly sending again, so the customer is refunded exactly once.",
      cta: { href: LINKS.lostResponsePlan, text: "See the example plan" },
    },
  ];
  return (
    <section
      id="moments"
      aria-labelledby="moments-h"
      className="scroll-mt-20 border-b border-line bg-sunken/50"
    >
      <div className={SECTION}>
        <Heading
          id="moments-h"
          eyebrow="Moments worth watching"
          lead="The things that go wrong between approval and apply, and what Rehearsal does about each."
        >
          What happens when the world moves
        </Heading>
        <ul className="mt-10 grid gap-4 lg:grid-cols-3">
          {moments.map((m) => (
            <li key={m.title}>
              <Card className="flex h-full flex-col p-6">
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${m.tone}`}>
                  <Icon name={m.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-ink">{m.title}</h3>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted">{m.text}</p>
                <a
                  href={m.cta.href}
                  className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
                >
                  {m.cta.text}
                  <Icon name="arrow" className="h-4 w-4" />
                </a>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Guarantees() {
  const items: { icon: IconName; title: string; text: string }[] = [
    {
      icon: "hash",
      title: "Approval is for an exact hash",
      text: "Any change makes a new revision that needs a new approval. The browser never sends action bodies.",
    },
    {
      icon: "lock",
      title: "No model in execution",
      text: "The executor holds no model key. Advice can prioritize a check; it can never release a hold.",
    },
    {
      icon: "note",
      title: "Journal before dispatch",
      text: "The exact request is saved before it is sent. An unknown outcome is reconciled by reading, never blindly re-sent.",
    },
    {
      icon: "shield",
      title: "Separate credentials",
      text: "The planner never sees production URLs or the admin token. The executor never sees a model key.",
    },
    {
      icon: "refund",
      title: "Money is never a float",
      text: "Integer minor units plus a currency, everywhere, so 42.10 is 4210 and nothing rounds.",
    },
    {
      icon: "edit",
      title: "Typed operations only",
      text: "Three operations: create a refund, patch ticket fields, append a private note. No arbitrary URLs or JSON patches.",
    },
    {
      icon: "clock",
      title: "Append-only history",
      text: "Plans, approvals, attempts and receipts are never edited. A correction is a new row.",
    },
    {
      icon: "eye",
      title: "Evidence is labelled",
      text: "Results say fixture until they have run against real Era images. Nothing is claimed that wasn't run.",
    },
  ];
  return (
    <section
      id="guarantees"
      aria-labelledby="guarantees-h"
      className="scroll-mt-20 border-b border-line"
    >
      <div className={SECTION}>
        <Heading
          id="guarantees-h"
          eyebrow="Guarantees"
          lead="These are the product. Breaking one is a bug even if the tests pass."
        >
          Rules the engine never bends
        </Heading>
        <ul className="mt-10 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((it) => (
            <li key={it.title}>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Icon name={it.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-ink">{it.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-muted">{it.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Honest() {
  const points = [
    "It runs against Era's Stripe and Zendesk simulators. Both the copy and “production” are simulators, and the page says so wherever it matters.",
    "One workflow today: remediating a billing incident with refunds, ticket updates and private notes.",
    "It is built for batch operations. An agent that must react to live side effects, such as waiting for a customer's reply, doesn't fit plan-and-apply.",
    "Example plans and saved replays are fixtures: produced by the real engine on test data, not by real Era images.",
  ];
  return (
    <section
      id="honest"
      aria-labelledby="honest-h"
      className="scroll-mt-20 border-b border-line bg-sunken/50"
    >
      <div
        className={`${SECTION} grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16`}
      >
        <Heading
          id="honest-h"
          eyebrow="What's real"
          lead="Rehearsal's own rule is to label its evidence. So here is what it is, and what it isn't."
        >
          Honest about the limits
        </Heading>
        <ul className="space-y-4">
          {points.map((p) => (
            <li
              key={p}
              className="flex gap-3 rounded-xl border border-line bg-surface p-4 shadow-card"
            >
              <Icon name="info" className="mt-0.5 h-5 w-5 text-info" />
              <p className="text-sm leading-6 text-ink">{p}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section aria-labelledby="closing" className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_20rem_at_50%_120%,var(--accent-soft),transparent_70%)]"
      />
      <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28">
        <h2
          id="closing"
          className="text-[28px] leading-9 font-semibold tracking-tight text-ink sm:text-4xl sm:leading-[2.75rem]"
        >
          See the whole job before it happens
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-muted sm:text-lg">
          Open the example plan, uncheck a customer and watch their note drop, or watch a saved run
          where a new charge appears after approval.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LinkButton variant="primary" size="lg" href={LINKS.examplePlan} trailingIcon="arrow">
            Open the example plan
          </LinkButton>
          <LinkButton variant="secondary" size="lg" href={LINKS.replay} icon="film">
            Watch a saved replay
          </LinkButton>
        </div>
      </div>
    </section>
  );
}
