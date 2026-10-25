/**
 * Real Clerk sessions for the T4.13 gate. A sign-in ticket from the backend API is redeemed through
 * the instance's frontend API from the review UI's origin, the way the browser signs in, so the
 * session token carries `azp` and IAM's authorized-parties check applies unchanged. Session tokens
 * live a minute; `token()` mints a fresh one when the last is about to expire. Development
 * instances only (`sk_test_`).
 */

const CLERK_API = "https://api.clerk.com/v1";

export interface GateSession {
  username: string;
  userId: string;
  sessionId: string;
  orgId: string | null;
  orgRole: string | null;
  token(): Promise<string>;
  revoke(): Promise<void>;
}

async function backend<T>(secretKey: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CLERK_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`clerk ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The frontend API host is the publishable key's payload: base64 of `<host>$`. */
function frontendApi(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] ?? "";
  return `https://${Buffer.from(encoded, "base64").toString().replace(/\$$/, "")}`;
}

function claimsOf(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as {
    exp: number;
    o?: { id?: string; rol?: string };
  };
}

export async function openSession(
  keys: { secretKey: string; publishableKey: string; origin: string },
  username: string,
): Promise<GateSession> {
  const { secretKey, origin } = keys;
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("the gate opens Clerk sessions only on a development instance (sk_test_)");
  }
  const fapi = frontendApi(keys.publishableKey);
  const users = await backend<{ id: string; username: string | null }[]>(
    secretKey,
    `/users?username=${encodeURIComponent(username)}`,
  );
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`no Clerk user ${username}`);
  const memberships = await backend<{ data: { organization: { id: string } }[] }>(
    secretKey,
    `/users/${user.id}/organization_memberships?limit=1`,
  );
  const org = memberships.data[0]?.organization.id;
  if (!org) throw new Error(`${username} is in no organization`);
  const ticket = await backend<{ token: string }>(secretKey, "/sign_in_tokens", {
    user_id: user.id,
    expires_in_seconds: 600,
  });

  const devRes = await fetch(`${fapi}/v1/dev_browser`, { method: "POST", headers: { origin } });
  if (!devRes.ok) throw new Error(`clerk dev_browser → ${devRes.status}`);
  const devBrowser = ((await devRes.json()) as { token: string }).token;
  const frontend = async <T>(path: string, body: Record<string, string>): Promise<T> => {
    const res = await fetch(`${fapi}/v1${path}?__clerk_db_jwt=${devBrowser}`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new Error(`clerk frontend ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  const signIn = await frontend<{ response?: { status?: string; created_session_id?: string } }>(
    "/client/sign_ins",
    { strategy: "ticket", ticket: ticket.token },
  );
  const sessionId = signIn.response?.created_session_id;
  if (signIn.response?.status !== "complete" || !sessionId) {
    throw new Error(`clerk ticket sign-in for ${username} → ${signIn.response?.status}`);
  }
  await frontend(`/client/sessions/${sessionId}/touch`, { active_organization_id: org });

  let current = "";
  const token = async () => {
    if (current && claimsOf(current).exp * 1000 - Date.now() > 15_000) return current;
    const { jwt } = await frontend<{ jwt: string }>(`/client/sessions/${sessionId}/tokens`, {
      organization_id: org,
    });
    current = jwt;
    return jwt;
  };
  const claims = claimsOf(await token());
  return {
    username,
    userId: user.id,
    sessionId,
    orgId: claims.o?.id ?? null,
    orgRole: claims.o?.rol ?? null,
    token,
    revoke: async () => {
      await backend(secretKey, `/sessions/${sessionId}/revoke`, {});
    },
  };
}
