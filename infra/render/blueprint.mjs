import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const value = (key, value) => ({ key, value });
const secret = (key) => ({ key, sync: false });
const generated = (key) => ({ key, generateValue: true });
const service = (key, name, property = "host", type = "pserv", envVarKey) => ({
  key,
  fromService: { name, type, ...(envVarKey ? { envVarKey } : { property }) },
});
const apiSecret = (key) => service(key, "rehearsal-api", "envVarKey", "web", key);
const database = {
  key: "DATABASE_URL",
  fromDatabase: { name: "rehearsal-db", property: "connectionString" },
};
const images = {
  stripe:
    "docker.io/erabyeon/stripe@sha256:2981ee73e05ecd061a5754e87e5a3775d3e857ef29ea2a3b544de038adf0a599",
  zendesk:
    "docker.io/erabyeon/zendesk@sha256:f91c3190378822f8400caf22a47e0a2107a31ba3aa912251425080829bab6444",
  slack:
    "docker.io/erabyeon/slack@sha256:33382931f381da5dca51c45ad4ad7c7bfc07644d3240465bfd41e7b7ea2cb75f",
};
const vendors = Object.keys(images);
const worlds = ["planning", "operational", "rehearsal"];
const worldHost = (vendor, world) =>
  service(
    `ERA_${vendor.toUpperCase()}_${world.toUpperCase()}_HOST`,
    `rehearsal-${vendor}-${world}`,
  );
const worldHosts = (world) => vendors.map((vendor) => worldHost(vendor, world));
const apiHost = service("REHEARSAL_API_HOST", "rehearsal-api", "host", "web");
const iamHost = service("REHEARSAL_IAM_HOST", "rehearsal-iam");
const certs = (role) => [
  secret("DEPLOY_IAM_CA_PEM"),
  secret(`DEPLOY_${role.toUpperCase()}_CERT_PEM`),
  secret(`DEPLOY_${role.toUpperCase()}_KEY_PEM`),
];
function nodeService(name, type, role, envVars, extra = {}) {
  return {
    name,
    type,
    runtime: "node",
    region: "ohio",
    plan: "0.5c-512mb",
    autoDeployTrigger: "off",
    numInstances: 1,
    maxShutdownDelaySeconds: 180,
    buildCommand: `corepack enable && pnpm install --frozen-lockfile --prod=false${role === "api" ? " && pnpm --filter @rehearsal/web build" : ""}`,
    startCommand: `node infra/render/start.mjs ${role}`,
    envVars: [value("NODE_VERSION", "24.11.1"), ...envVars],
    ...extra,
  };
}

export const blueprint = {
  previews: { generation: "off" },
  services: [
    nodeService(
      "rehearsal-api",
      "web",
      "api",
      [
        database,
        value("API_PORT", "10000"),
        iamHost,
        ...certs("api"),
        ...worlds.flatMap(worldHosts),
        value("ERA_TENANT", "rehearsal-demo"),
        ...[
          "ERA_ADMIN_TOKEN",
          "REHEARSAL_ERA_ADMIN_TOKEN",
          "PLANNER_WORKER_SECRET",
          "EXECUTOR_WORKER_SECRET",
          "REHEARSAL_WORKER_SECRET",
        ].map(generated),
        secret("VITE_CLERK_PUBLISHABLE_KEY"),
      ],
      {
        healthCheckPath: "/api/health",
        preDeployCommand: "pnpm --filter @rehearsal/db migrate",
      },
    ),
    nodeService("rehearsal-iam", "pserv", "iam", [
      value("IAM_HOST", "0.0.0.0"),
      value("IAM_PORT", "3443"),
      ...certs("server"),
      secret("CLERK_PUBLISHABLE_KEY"),
      secret("CLERK_SECRET_KEY"),
      secret("CLERK_AUTHORIZED_PARTIES"),
    ]),
    nodeService("rehearsal-planner", "worker", "planner", [
      apiHost,
      apiSecret("PLANNER_WORKER_SECRET"),
      ...worldHosts("planning"),
      value("ERA_TENANT", "rehearsal-demo"),
      value("PLANNER_MODEL", "gemini-4-argon"),
      value("GOOGLE_CLOUD_LOCATION", "global"),
      secret("GOOGLE_CLOUD_PROJECT"),
      secret("DEPLOY_GOOGLE_CREDENTIALS_JSON"),
      value("CUSTOMER_REPLIES", "1"),
      value("BALANCE_CREDITS", "1"),
      secret("RUN_SUMMARY_CHANNEL"),
    ]),
    nodeService("rehearsal-executor", "worker", "executor", [
      database,
      apiHost,
      apiSecret("EXECUTOR_WORKER_SECRET"),
      iamHost,
      ...certs("executor"),
      ...worldHosts("operational"),
      value("ERA_TENANT", "rehearsal-demo"),
    ]),
    nodeService("rehearsal-rehearsal", "worker", "rehearsal", [
      database,
      apiHost,
      apiSecret("REHEARSAL_WORKER_SECRET"),
      ...worldHosts("rehearsal"),
    ]),
    ...worlds.flatMap((world) =>
      vendors.map((vendor) => ({
        name: `rehearsal-${vendor}-${world}`,
        type: "pserv",
        runtime: "image",
        image: { url: images[vendor] },
        region: "ohio",
        plan: "0.5c-512mb",
        numInstances: 1,
        envVars: [
          value("PORT", "8080"),
          value("SIMCORE_SEED", "42"),
          value("SIMCORE_TODAY", "2026-10-01"),
          value("SIMCORE_STATE", "day1"),
          value("SIMCORE_FIDELITY", "high"),
          value("SIMCORE_ALLOW_CLIENT_WRITES", "1"),
          service(
            "SIMCORE_ADMIN_TOKEN",
            "rehearsal-api",
            "envVarKey",
            "web",
            world === "rehearsal" ? "REHEARSAL_ERA_ADMIN_TOKEN" : "ERA_ADMIN_TOKEN",
          ),
        ],
      })),
    ),
  ],
  databases: [
    {
      name: "rehearsal-db",
      region: "ohio",
      plan: "0.1c-256mb",
      diskSizeGB: 1,
      postgresMajorVersion: "17",
      databaseName: "rehearsal",
      user: "rehearsal",
      ipAllowList: [],
    },
  ],
};

// JSON is a YAML subset. Keeping the generated file deterministic lets tests audit every binding.
export const blueprintText = `${JSON.stringify(blueprint, null, 2)}\n`;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("../../render.yaml", import.meta.url), blueprintText);
}
