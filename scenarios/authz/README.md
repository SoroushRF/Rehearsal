# Authorization rules

Versioned rule files for IAM (decision [0014](../../docs/decisions/0014-iam-permission-based-authorization.md)). They map Clerk roles to permissions and list one rule per action.

- `rehearsal-authz.v1.json`: Clerk role → role → permissions, one rule per person-facing API route, and `run:admit` (one grant, or two people when policy says so). `apps/api/test/authz-rules.test.ts` parses it against `AuthzRuleFile` and fails if a registered route has no rule.
- IAM loads a file by `id` and `version`; the caller names which and cannot send the rule text.
- A change is a new version file (`rehearsal-authz.v2.json`), reviewed in a PR. Never edit a version once it has been used: grants record the version they were approved under.
