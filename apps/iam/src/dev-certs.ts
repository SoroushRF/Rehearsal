import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Local mTLS material. The private keys are generated on the machine and never committed. */
export interface DevCerts {
  dir: string;
  ca: string;
  serverCert: string;
  serverKey: string;
  apiCert: string;
  apiKey: string;
  executorCert: string;
  executorKey: string;
}

function openssl(args: string[]): void {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "openssl failed");
  }
}

function issued(
  dir: string,
  ca: string,
  caKey: string,
  name: string,
  server: boolean,
): { cert: string; key: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  const csr = join(dir, `${name}.csr`);
  const use = server
    ? [
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-addext",
        "extendedKeyUsage=serverAuth",
      ]
    : ["-addext", "extendedKeyUsage=clientAuth"];
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    `/CN=${name}`,
    ...use,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "3650",
    "-copy_extensions",
    "copy",
  ]);
  rmSync(csr, { force: true });
  return { cert, key };
}

/**
 * A private CA plus a server certificate and one client certificate each for the API and the
 * executor. Existing files are kept, so a restart does not rotate a certificate out from under a
 * running process.
 */
export function generateDevCerts(dir: string): DevCerts {
  mkdirSync(dir, { recursive: true });
  const caKey = join(dir, "ca.key");
  const ca = join(dir, "ca.crt");
  if (!existsSync(ca) || !existsSync(caKey)) {
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-days",
      "3650",
      "-subj",
      "/CN=rehearsal-iam-ca",
    ]);
  }
  const server = existsSync(join(dir, "server.crt"))
    ? { cert: join(dir, "server.crt"), key: join(dir, "server.key") }
    : issued(dir, ca, caKey, "server", true);
  const api = existsSync(join(dir, "api.crt"))
    ? { cert: join(dir, "api.crt"), key: join(dir, "api.key") }
    : issued(dir, ca, caKey, "api", false);
  const executor = existsSync(join(dir, "executor.crt"))
    ? { cert: join(dir, "executor.crt"), key: join(dir, "executor.key") }
    : issued(dir, ca, caKey, "executor", false);
  return {
    dir,
    ca,
    serverCert: server.cert,
    serverKey: server.key,
    apiCert: api.cert,
    apiKey: api.key,
    executorCert: executor.cert,
    executorKey: executor.key,
  };
}
