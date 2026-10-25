import { describe, expect, it } from "vitest";
import { clerkVerifierFromEnv } from "../src/clerk";

const token = process.env.IAM_CLERK_TEST_TOKEN;
const live = Boolean(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY && token);

/**
 * Optional. Set CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY and IAM_CLERK_TEST_TOKEN (a development
 * session token) to check a real Clerk session. CI does not have the token, so this stays skipped.
 */
describe.skipIf(!live)("real Clerk", () => {
  it("verifies a development session token", async () => {
    const clerk = clerkVerifierFromEnv();
    expect(clerk).toBeDefined();
    const person = await clerk?.verify(token ?? "");
    expect(person?.userId).toEqual(expect.any(String));
  });
});
