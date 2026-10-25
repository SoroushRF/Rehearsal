import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MembersPanel } from "../src/components/MembersPanel";

const html = (permissions: string[] | null) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MembersPanel apiFetch={async () => new Response()} permissions={permissions} />
    </QueryClientProvider>,
  );

describe("MembersPanel", () => {
  it("hides invite and role change from a member", () => {
    const out = html(["rehearsal:read:plan"]);
    expect(out).not.toContain("invite-form");
    expect(out).not.toContain("role-form");
  });

  it("shows the invite form only with invite permission", () => {
    const out = html(["rehearsal:invite:member"]);
    expect(out).toContain('data-testid="invite-form"');
    expect(out).not.toContain('data-testid="role-form"');
    expect(out).toContain("org:owner");
    expect(out).toContain("org:finance_lead");
    expect(out).toContain("org:support_lead");
    expect(out).toContain("org:member");
  });

  it("shows the role selector only with manage permission", () => {
    const out = html(["rehearsal:manage:role"]);
    expect(out).toContain('data-testid="role-form"');
    expect(out).not.toContain('data-testid="invite-form"');
  });
});
