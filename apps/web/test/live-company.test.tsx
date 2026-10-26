import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompanyOverview } from "../src/components/CompanyOverview";
import { IncidentRows } from "../src/components/IncidentForm";
import { LIVE_KINDS, stageOf } from "../src/components/LivePlans";
import { RehearseBar } from "../src/components/Rehearse";
import { companyFixture, incidentFixtures } from "../src/fixtures";
import { IdentityProvider } from "../src/identity";

const IDENTITY = "user_a/org_a";
const noFetch = async () => new Response();

/** Renders with the company already in the cache, as after `GET /api/company` resolved. */
function render(node: ReactNode, seed?: (client: QueryClient) => void) {
  const client = new QueryClient();
  seed?.(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IdentityProvider identity={IDENTITY}>{node}</IdentityProvider>
    </QueryClientProvider>,
  );
}

const withCompany = (client: QueryClient) =>
  client.setQueryData(["tenant", IDENTITY, "company"], {
    snapshot: companyFixture,
    fixture: false,
  });

describe("company overview", () => {
  const out = render(
    <CompanyOverview apiFetch={noFetch} kinds={LIVE_KINDS} canCreateProblem onOpenRun={() => {}} />,
    withCompany,
  );

  it("marks the rows a run's receipt changed, with the run", () => {
    expect(out).toMatch(/data-id="ch_3Q8aD1" data-changed="true"/);
    expect(out).toMatch(/data-id="ch_3Q8aC9" data-changed="false"/);
    expect(out).toContain("run_fixture_01");
  });

  it("counts every tab and formats money from minor units", () => {
    expect(out).toMatch(/Charges<span[^>]*>6</);
    expect(out).toMatch(/Customers<span[^>]*>4</);
    expect(out).toContain("$42.10 CAD");
  });

  it("offers a problem to create where the person may rehearse", () => {
    expect(out).toContain('aria-label="Create a problem"');
    const reader = render(
      <CompanyOverview
        apiFetch={noFetch}
        kinds={LIVE_KINDS}
        canCreateProblem={false}
        onOpenRun={() => {}}
      />,
      withCompany,
    );
    expect(reader).not.toContain('aria-label="Create a problem"');
  });

  it("shows a skeleton while the world seeds", () => {
    const loading = render(
      <CompanyOverview
        apiFetch={noFetch}
        kinds={LIVE_KINDS}
        canCreateProblem
        onOpenRun={() => {}}
      />,
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("Loading company…");
  });
});

describe("rehearse bar", () => {
  it("rehearses the incident it is given", () => {
    const out = render(
      <RehearseBar apiFetch={noFetch} incidentId="INC-BILL-1031" onStored={() => {}} />,
    );
    expect(out).toContain("INC-BILL-1031");
    expect(out).not.toContain("INC-BILL-0927");
  });

  it("defaults to the built-in incident", () => {
    expect(render(<RehearseBar apiFetch={noFetch} onStored={() => {}} />)).toContain(
      "INC-BILL-0927",
    );
  });
});

describe("incident list", () => {
  it("lists each incident with its window and marks the one being rehearsed", () => {
    const out = render(
      <IncidentRows
        incidents={incidentFixtures}
        active="INC-BILL-1031"
        allowed
        onRehearse={() => {}}
      />,
    );
    expect(out).toMatch(/data-incident="INC-BILL-1031" aria-current="true"/);
    expect(out).toContain("2026-09-01 – 2026-09-30");
  });
});

describe("process stage", () => {
  it.each([
    [null, false, null, 1],
    ["planning", false, null, 2],
    ["queued", true, "completed", 2],
    ["stored", true, null, 3],
    [null, true, "applying", 4],
    [null, true, "held", 5],
  ] as const)("rehearsal %s, plan %s, run %s → %s", (rehearsal, hasPlan, run, expected) => {
    expect(stageOf(rehearsal, hasPlan, run)).toBe(expected);
  });
});
