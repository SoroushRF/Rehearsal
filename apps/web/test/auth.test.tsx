import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountBar, AuthProvider, clerkKey, Me, VerifiedIdentity } from "../src/auth";

describe("GET /api/me", () => {
  it("parses the Clerk role and permissions, not a roles list", () => {
    expect(
      Me.parse({
        userId: "user_a",
        orgId: "org_a",
        clerkRole: "org:owner",
        permissions: ["rehearsal:invite:member"],
      }),
    ).toMatchObject({ clerkRole: "org:owner", permissions: ["rehearsal:invite:member"] });
    expect(
      Me.safeParse({ userId: "user_a", orgId: "org_a", roles: ["finance_lead"] }).success,
    ).toBe(false);
  });

  it("shows the Clerk role and the permissions in the header", () => {
    const html = renderToStaticMarkup(<VerifiedIdentity clerkRole="org:finance_lead" />);
    expect(html).toContain("org:finance_lead");
    expect(html).not.toContain("rehearsal:apply:plan");
    expect(html).not.toContain("rehearsal:approve:finance_step");
    expect(html).not.toContain("No permissions");
  });
});

describe.skipIf(clerkKey)("without a Clerk publishable key", () => {
  it("runs read-only: no provider, no sign-in, says why", () => {
    const html = renderToStaticMarkup(
      <AuthProvider>
        <AccountBar />
      </AuthProvider>,
    );
    expect(html).toContain("plans are read-only fixtures");
    expect(html).not.toContain("Sign in</button>");
  });
});
