import { createClerkClient } from "@clerk/backend";

/** Who Clerk says is holding this session token. `orgId` null means no active organization. */
export interface VerifiedPerson {
  userId: string;
  orgId: string | null;
  orgRole: string | null;
}

/** The only way IAM learns who a person is. Tests pass a fake; the process uses Clerk. */
export interface ClerkVerifier {
  verify(token: string): Promise<VerifiedPerson | null>;
}

/**
 * Clerk's networkless session-token check. The secret stays in this process. Undefined when the
 * keys are absent, so a person question is denied rather than checked with a guess.
 */
export function clerkVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClerkVerifier | undefined {
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return undefined;
  const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const clerk = createClerkClient({ secretKey, publishableKey });
  return {
    async verify(token) {
      const state = await clerk.authenticateRequest(
        new Request("https://iam.local/decide", { headers: { authorization: `Bearer ${token}` } }),
        {
          acceptsToken: "session_token",
          ...(authorizedParties?.length ? { authorizedParties } : {}),
        },
      );
      if (!state.isAuthenticated) return null;
      const auth = state.toAuth();
      return {
        userId: auth.userId,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
      };
    },
  };
}
