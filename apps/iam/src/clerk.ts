import { createClerkClient } from "@clerk/backend";

/** Who Clerk says is holding this session token. `orgId` null means no active organization. */
export interface VerifiedPerson {
  userId: string;
  orgId: string | null;
  orgRole: string | null;
  /** Clerk's session id, when this verifier has one. Identity refuses a person without it. */
  sessionId?: string | null;
}

/** The only way IAM learns who a person is. Tests pass a fake; the process uses Clerk. */
export interface ClerkVerifier {
  verify(token: string): Promise<VerifiedPerson | null>;
}

/** One row of an organization's membership list. `userId` is null when Clerk omitted the person. */
export interface ClerkOrgMembership {
  userId: string | null;
  role: string;
}

/**
 * Clerk writes for membership. The API never holds one of these. Tests pass a fake; the process
 * builds one from the same secret as the verifier.
 */
export interface ClerkOrgClient {
  listMemberships(organizationId: string): Promise<ClerkOrgMembership[]>;
  createInvitation(input: {
    organizationId: string;
    emailAddress: string;
    role: string;
    inviterUserId: string;
  }): Promise<void>;
  updateMembershipRole(input: {
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<void>;
}

/** The slice of Clerk's organization API this process calls. */
export interface ClerkOrganizationApi {
  getOrganizationMembershipList(params: {
    organizationId: string;
    limit: number;
    offset: number;
  }): Promise<{
    data: ReadonlyArray<{
      role: string;
      publicUserData?: { userId?: string | null } | null;
    }>;
    totalCount: number;
  }>;
  createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    role: string;
    inviterUserId: string;
  }): Promise<unknown>;
  updateOrganizationMembership(params: {
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<unknown>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Reads every membership page before a role change, so an owner on a later page still counts.
 * A repeated user, or a list that ends before `totalCount`, throws: the caller must not
 * change a role on a count it does not trust.
 */
export function clerkOrgClientFromBackend(organizations: ClerkOrganizationApi): ClerkOrgClient {
  return {
    async listMemberships(organizationId) {
      const memberships: ClerkOrgMembership[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      for (let page = 0; page < MAX_PAGES && offset < total; page += 1) {
        const batch = await organizations.getOrganizationMembershipList({
          organizationId,
          limit: PAGE_SIZE,
          offset,
        });
        total = batch.totalCount;
        if (batch.data.length === 0) break;
        for (const row of batch.data) {
          const userId = row.publicUserData?.userId || null;
          if (userId) {
            if (seen.has(userId)) throw new Error("membership list repeated a user");
            seen.add(userId);
          }
          memberships.push({ userId, role: row.role });
        }
        offset += batch.data.length;
        if (batch.data.length < PAGE_SIZE) break;
      }
      if (offset < total) throw new Error("membership list incomplete");
      return memberships;
    },
    async createInvitation(input) {
      await organizations.createOrganizationInvitation(input);
    },
    async updateMembershipRole(input) {
      await organizations.updateOrganizationMembership(input);
    },
  };
}

export interface ClerkServices {
  verifier: ClerkVerifier;
  orgs: ClerkOrgClient;
}

/**
 * Clerk's session-token check and organization writes. The secret stays in this process.
 * Undefined when the keys are absent, so a person question is denied rather than checked
 * with a guess, and a membership write is not attempted.
 */
export function clerkFromEnv(env: NodeJS.ProcessEnv = process.env): ClerkServices | undefined {
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return undefined;
  const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const clerk = createClerkClient({ secretKey, publishableKey });
  return {
    verifier: {
      async verify(token) {
        const state = await clerk.authenticateRequest(
          new Request("https://iam.local/decide", {
            headers: { authorization: `Bearer ${token}` },
          }),
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
          sessionId: auth.sessionId ?? null,
        };
      },
    },
    orgs: clerkOrgClientFromBackend(clerk.organizations),
  };
}

/** Session-token check only. Same secret and same absence rule as `clerkFromEnv`. */
export function clerkVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClerkVerifier | undefined {
  return clerkFromEnv(env)?.verifier;
}
