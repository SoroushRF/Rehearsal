import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain } from "../api";
import { actionAllowed, ORG_ROLES, type OrgRoleName } from "../permissions";
import { Alert, Button, Card } from "./ui";

const InviteResult = z.object({ email: z.string(), role: z.string() });
const RoleResult = z.object({ userId: z.string(), role: z.string() });

const field = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";

/**
 * Invite and role change for someone the API already allowed. The organization is the one on
 * the session; it is not a field in either body.
 */
export function MembersPanel({
  apiFetch,
  permissions,
}: {
  apiFetch: ApiFetch;
  permissions: readonly string[] | null;
}) {
  const canInvite = actionAllowed(permissions, "invite");
  const canManage = actionAllowed(permissions, "manageRole");
  if (!canInvite && !canManage) return null;

  return (
    <Card aria-label="Members" className="flex flex-col gap-5 p-4 sm:p-5">
      <div>
        <h2 className="text-[15px] leading-6 font-semibold text-ink">Members</h2>
        <p className="text-sm leading-5 text-muted">
          Invites and role changes go through Rehearsal. The organization is the one you're signed
          in to.
        </p>
      </div>
      {canInvite && <InviteForm apiFetch={apiFetch} />}
      {canManage && <RoleForm apiFetch={apiFetch} />}
    </Card>
  );
}

function RoleOptions({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (role: OrgRoleName) => void;
}) {
  return (
    <select
      id={id}
      className={field}
      value={value}
      onChange={(e) => onChange(e.target.value as OrgRoleName)}
    >
      {ORG_ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  );
}

function InviteForm({ apiFetch }: { apiFetch: ApiFetch }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRoleName>("org:member");
  const invite = useMutation({
    mutationFn: () =>
      call(apiFetch, InviteResult, "/api/members/invitations", { email: email.trim(), role }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  return (
    <form data-testid="invite-form" className="flex flex-col gap-3" onSubmit={submit}>
      <h3 className="text-sm font-semibold text-ink">Invite a member</h3>
      <div>
        <label htmlFor="invite-email" className="text-xs font-medium text-muted">
          Email
        </label>
        <input
          id="invite-email"
          type="email"
          required
          autoComplete="off"
          className={field}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="invite-role" className="text-xs font-medium text-muted">
          Invite role
        </label>
        <RoleOptions id="invite-role" value={role} onChange={setRole} />
      </div>
      <Button type="submit" variant="primary" loading={invite.isPending}>
        Send invite
      </Button>
      {invite.isError && <Alert>{explain(invite.error)}</Alert>}
      {invite.data && (
        <Alert tone="good">
          Invited {invite.data.email} as {invite.data.role}.
        </Alert>
      )}
    </form>
  );
}

function RoleForm({ apiFetch }: { apiFetch: ApiFetch }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<OrgRoleName>("org:member");
  const change = useMutation({
    mutationFn: () =>
      call(
        apiFetch,
        RoleResult,
        `/api/members/${encodeURIComponent(userId.trim())}/role`,
        { role },
        "PATCH",
      ),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };

  return (
    <form data-testid="role-form" className="flex flex-col gap-3" onSubmit={submit}>
      <h3 className="text-sm font-semibold text-ink">Change a role</h3>
      <div>
        <label htmlFor="member-user" className="text-xs font-medium text-muted">
          Member
        </label>
        <input
          id="member-user"
          required
          autoComplete="off"
          className={field}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="member-role" className="text-xs font-medium text-muted">
          New role
        </label>
        <RoleOptions id="member-role" value={role} onChange={setRole} />
      </div>
      <Button type="submit" variant="secondary" loading={change.isPending}>
        Change role
      </Button>
      {change.isError && <Alert>{explain(change.error)}</Alert>}
      {change.data && (
        <Alert tone="good">
          {change.data.userId} is now {change.data.role}.
        </Alert>
      )}
    </form>
  );
}
