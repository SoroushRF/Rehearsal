import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeAgentMemory } from "./fake-agent-memory";

/**
 * Serves the fake over HTTP on 127.0.0.1, for the operator commands under test as child
 * processes. `intercept` may answer a request itself (a failing service, say) instead of the fake.
 */
export async function serveFake(
  fake: FakeAgentMemory,
  intercept: (method: string, path: string) => Response | undefined = () => undefined,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const method = req.method ?? "GET";
    const answer =
      intercept(method, req.url ?? "") ??
      (await fake.fetch(`http://fake${req.url}`, {
        method,
        headers: { authorization: req.headers.authorization ?? "" },
        ...(body === "" ? {} : { body }),
      }));
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(await answer.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
