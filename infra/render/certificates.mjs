import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Run after Render assigns IAM's private hostname. Only this ignored operator directory has
// the CA private key. The three deployed services receive their own leaf key, never the CA key.
const hostname = process.argv[2];
if (!hostname || !/^[a-zA-Z0-9.-]+$/.test(hostname)) {
  throw new Error("usage: node infra/render/certificates.mjs <IAM private hostname>");
}
const dir = resolve(".deploy/render/certificates");
mkdirSync(dir, { recursive: true });
function openssl(args) {
  const result = spawnSync("openssl", args, { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "openssl failed");
}
if (existsSync(join(dir, "ca.key")))
  throw new Error("certificates already exist; refusing to rotate them");
openssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  join(dir, "ca.key"),
  "-out",
  join(dir, "ca.crt"),
  "-days",
  "90",
  "-subj",
  "/CN=rehearsal-render-ca",
]);
for (const name of ["server", "api", "executor"]) {
  const csr = join(dir, `${name}.csr`);
  const extensions = join(dir, `${name}.ext`);
  writeFileSync(
    extensions,
    `extendedKeyUsage=${name === "server" ? "serverAuth" : "clientAuth"}\n${name === "server" ? `subjectAltName=DNS:${hostname}\n` : ""}`,
  );
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(dir, `${name}.key`),
    "-out",
    csr,
    "-subj",
    `/CN=${name}`,
    "-addext",
    `extendedKeyUsage=${name === "server" ? "serverAuth" : "clientAuth"}`,
    ...(name === "server" ? ["-addext", `subjectAltName=DNS:${hostname}`] : []),
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    join(dir, "ca.crt"),
    "-CAkey",
    join(dir, "ca.key"),
    "-CAcreateserial",
    "-out",
    join(dir, `${name}.crt`),
    "-days",
    "90",
    "-extfile",
    extensions,
  ]);
}
console.log(`Created 90-day certificates for ${hostname} in .deploy/render/certificates (ignored)`);
