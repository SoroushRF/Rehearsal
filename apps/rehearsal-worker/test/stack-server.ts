import { createServer } from "node:http";
import { startStack } from "./stack";

/**
 * The real rehearsal stack as a process, for browser tests that can't import it (apps/web e2e).
 * Prints one `STACK {"api","control"}` line once the API and the worker are up. The control port
 * registers orgs, people and stored plans; it's a test seam, never part of the API.
 */
const stack = await startStack();
const control = createServer((req, res) => {
  let raw = "";
  req.on("data", (d: Buffer) => {
    raw += d.toString();
  });
  req.on("end", async () => {
    try {
      if (req.method !== "POST" || req.url !== "/org") {
        res.writeHead(404).end();
        return;
      }
      const { orgId, userIds, plan } = JSON.parse(raw);
      const tokens = await stack.org(orgId, userIds, plan);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tokens }));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
});
control.listen(0, "127.0.0.1", () => {
  const address = control.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`STACK ${JSON.stringify({ api: stack.url, control: `http://127.0.0.1:${port}` })}`);
});

const stop = async () => {
  control.close();
  await stack.stop();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// The test runner closes stdin when it's done; stop then too (a Windows kill skips the signals).
process.stdin.on("end", stop);
process.stdin.resume();
