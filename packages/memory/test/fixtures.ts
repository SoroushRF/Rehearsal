import { AgentMemoryClient } from "../src/client";
import type { PrecedentRecord } from "../src/precedent";
import { AgentMemoryPrecedents } from "../src/precedents";
import { FakeAgentMemory } from "./fake-agent-memory";

export const SCOPE = "rehearsal/precedents";

export function precedent(overrides: Partial<PrecedentRecord> = {}): PrecedentRecord {
  return {
    id: "duplicate-charge-refund",
    version: 1,
    appliesTo: "billing.duplicate_charge",
    statement: "A duplicate charge found within 30 days is refunded in full to the original card.",
    conditions: ["the two charges have the same amount and customer", "neither is disputed"],
    exceptions: ["charges above 5000.00 CAD go to finance first"],
    effectiveFrom: "2026-10-01",
    effectiveUntil: null,
    author: { userId: "user_finance_1", role: "finance_lead" },
    approvedAt: "2026-10-20T15:04:05Z",
    ...overrides,
  };
}

export function setup({ today = "2026-10-24", key = "sp-test-key" } = {}) {
  const fake = new FakeAgentMemory();
  const client = new AgentMemoryClient({
    url: "http://fake/",
    context: "ctx",
    apiKey: key,
    fetch: fake.fetch,
  });
  const store = new AgentMemoryPrecedents(client, {
    scope: SCOPE,
    clock: { now: () => new Date(`${today}T12:00:00Z`) },
  });
  return { fake, client, store };
}
