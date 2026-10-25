import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { AuthzDecision as AuthzDecisionSchema, type AuthzRequest } from "@rehearsal/contracts";
import { decisionEchoes, type RunAdmit } from "@rehearsal/core";

const TIMEOUT_MS = 3_000;

export interface RunAdmitOptions {
  url: string;
  cert: string | Buffer;
  key: string | Buffer;
  ca: string | Buffer;
  timeoutMs?: number;
}

/**
 * mTLS to IAM for `run:admit` only. `ca` is the trust store for IAM's server certificate
 * (`rejectUnauthorized`), and `cert`/`key` are this worker's client certificate. A transport
 * failure, a malformed answer, or a decision that does not echo the question is unavailable.
 */
export function createRunAdmit(options: RunAdmitOptions): RunAdmit {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    async decide(request) {
      try {
        const parsed = AuthzDecisionSchema.safeParse(
          await postJson(options.url, "/v1/decide", request, options, timeoutMs),
        );
        if (!parsed.success || !decisionEchoes(request, parsed.data))
          return { kind: "unavailable" };
        return { kind: "decision", decision: parsed.data };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}

/** Undefined unless the certificate files and `IAM_URL` are all set. The process then cannot ask. */
export function runAdmitFromEnv(env: NodeJS.ProcessEnv = process.env): RunAdmit | undefined {
  const cert = env.IAM_CLIENT_CERT;
  const key = env.IAM_CLIENT_KEY;
  const ca = env.IAM_CLIENT_CA;
  const url = env.IAM_URL;
  if (!cert || !key || !ca || !url) return undefined;
  if (!existsSync(cert) || !existsSync(key) || !existsSync(ca)) return undefined;
  return createRunAdmit({
    url,
    cert: readFileSync(cert),
    key: readFileSync(key),
    ca: readFileSync(ca),
  });
}

function postJson(
  base: string,
  path: string,
  body: AuthzRequest,
  tls: { cert: string | Buffer; key: string | Buffer; ca: string | Buffer },
  timeoutMs: number,
): Promise<unknown> {
  const url = new URL(path, base);
  const payload = JSON.stringify(body);
  // Node refuses an IP address as the TLS server name. An IP URL is still checked against the
  // certificate's IP name; a hostname is sent as the server name and checked the same way.
  const servername = isIP(url.hostname) ? undefined : url.hostname;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        ...(servername ? { servername } : {}),
        method: "POST",
        path: `${url.pathname}${url.search}`,
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        rejectUnauthorized: true,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}
