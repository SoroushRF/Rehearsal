import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import type { AuthzRuleFile } from "@rehearsal/contracts";
import { answerRequest } from "./answer";
import type { ClerkVerifier } from "./clerk";

const BODY_LIMIT = 1_000_000;

export interface IamServerOptions {
  cert: string | Buffer;
  key: string | Buffer;
  /** Certificate authority that signed the API and executor client certificates. */
  clientCa: string | Buffer;
  /** Only these client certificate names may ask. Anyone else is dropped before the body is read. */
  allowedClients: readonly string[];
  files: ReadonlyMap<string, AuthzRuleFile>;
  clerk: ClerkVerifier;
  now?: () => Date;
  log?: (line: unknown) => void;
}

function clientName(socket: TLSSocket): string | undefined {
  const name = socket.getPeerCertificate().subject?.CN;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * HTTPS with a required client certificate. A connection IAM does not trust never reaches
 * `answerRequest`: Node rejects an unknown certificate during the handshake, and a trusted
 * certificate with the wrong name is destroyed before the body is read.
 */
export function createIamServer(options: IamServerOptions): Server {
  const allowed = new Set(options.allowedClients);
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const server = createServer(
    {
      cert: options.cert,
      key: options.key,
      ca: options.clientCa,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      const socket = req.socket as TLSSocket;
      const name = clientName(socket);
      if (!socket.authorized || !name || !allowed.has(name)) {
        socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        void (async () => {
          let raw: unknown;
          try {
            raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            raw = undefined;
          }
          const answer = await answerRequest(raw, {
            files: options.files,
            clerk: options.clerk,
            now: options.now?.() ?? new Date(),
          });
          log({ iam: "decision", ...answer.log });
          const body = JSON.stringify(answer.decision);
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
        })().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log({ iam: "decision", effect: "deny", reason: `error: ${message}`, matchedRule: null });
          if (!res.headersSent) res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              effect: "deny",
              action: "unknown",
              rule: { id: "unknown", version: 1 },
              resource: {},
              reason: `error: ${message}`,
            }),
          );
        });
      });
    },
  );
  return server;
}
