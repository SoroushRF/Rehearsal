import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountBar, AuthProvider, clerkKey } from "../src/auth";

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
