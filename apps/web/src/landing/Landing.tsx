import { useEffect } from "react";
import { ProcessDiagram } from "../components/ProcessDiagram";
import { Icon, LinkButton } from "../components/ui";

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
      <style>{FOCUS_CSS}</style>
      <Header />
      <main
        id="top"
        className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-16 sm:px-6 sm:py-24"
      >
        <h1 className="max-w-xl text-[40px] leading-[1.08] font-semibold tracking-tight text-ink sm:text-6xl">
          Terraform plan
          <br />
          for AI agents.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-ink">
          AI agents doing batch money operations need a dry run.
        </p>
        <div className="mt-10">
          <ProcessDiagram />
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-3">
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
        <a href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="brand-name">Rehearsal</span>
        </a>
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
      <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-8 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Built for Build North, October 2026</p>
        <a className="hover:text-ink hover:underline" href={LINKS.repo}>
          Source on GitHub
        </a>
      </div>
    </footer>
  );
}
