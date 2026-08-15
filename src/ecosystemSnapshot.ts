import type { IncomingMessage, ServerResponse } from "node:http";
import { getManagedFlyAppStates } from "./flyObservability.js";
import { listRepoConfigs } from "./repoMap.js";

export const ECOSYSTEM_SCHEMA_VERSION = "spmt.ecosystem-state/v1" as const;

export type PublicRuntimeState = {
  status: string;
  machineCount: number | null;
  states: Record<string, number>;
  failingCheckCount: number | null;
  observedAt: string;
};

export type PublicEcosystemApp = {
  id: string;
  name: string;
  lifecycle: "available" | "planned" | "internal";
  repository: { name: string };
  urls: { public: string; api?: string; health?: string };
  interfaces: Record<string, boolean>;
  services: Record<string, { flyApp: string; role: string; runtime: PublicRuntimeState }>;
  provenance: { declaredBy: "rotator-contract"; observedBy: "fly-machines-api" };
};

export type PublicEcosystemSnapshot = {
  schemaVersion: typeof ECOSYSTEM_SCHEMA_VERSION;
  generatedAt: string;
  producer: { app: "mtman-machine-rotator"; commit: string | null };
  apps: Record<string, PublicEcosystemApp>;
};

type DeclaredApp = Omit<PublicEcosystemApp, "repository" | "services" | "provenance"> & {
  repoId: string;
  serviceRoles?: Record<string, string>;
};

const DECLARED_APPS: DeclaredApp[] = [
  {
    id: "spmt",
    name: "SPMT",
    lifecycle: "available",
    repoId: "spmt-live",
    urls: { public: "https://spmt.live", api: "https://spmt.live/api", health: "https://spmt.live/api/health/oauth" },
    interfaces: { oauth: true, events: true, commlink: true, athena: true, workspace: true, xp: true },
    serviceRoles: { "spmt-live": "web", "spacemountain-live": "command-bridge" },
  },
  {
    id: "rotator",
    name: "MTMan Machine Rotator",
    lifecycle: "internal",
    repoId: "fly-machine-rotator",
    urls: { public: "https://mtman-machine-rotator.fly.dev", health: "https://mtman-machine-rotator.fly.dev/healthz" },
    interfaces: { ecosystemSnapshot: true, flyObservability: true, codingJobs: true, mcp: true },
    serviceRoles: { "mtman-machine-rotator": "operations", mountainview: "companion" },
  },
  {
    id: "streamweaver",
    name: "StreamWeaver",
    lifecycle: "available",
    repoId: "streamweaver",
    urls: { public: "https://streamweaver-new.fly.dev" },
    interfaces: { oauth: true, events: true, commlink: true, athena: true },
  },
  {
    id: "discord-stream-hub",
    name: "Discord Stream Hub",
    lifecycle: "available",
    repoId: "discord-stream-hub",
    urls: { public: "https://discord-stream-hub-new.fly.dev/dashboard", api: "https://discord-stream-hub-new.fly.dev/api" },
    interfaces: { oauth: true, events: true, commlink: true, athena: true },
    serviceRoles: { "discord-stream-hub-new": "web", "dsh-clip-worker": "clip-worker" },
  },
  {
    id: "hearmeout",
    name: "HearMeOut",
    lifecycle: "available",
    repoId: "hearmeout",
    urls: { public: "https://hearmeout-main.fly.dev", api: "https://hearmeout-main.fly.dev/api" },
    interfaces: { oauth: true, events: true, commlink: true },
    serviceRoles: { "hearmeout-main": "web", "hmo-dj-worker": "dj-worker" },
  },
  {
    id: "chat-tag",
    name: "ChatTag",
    lifecycle: "available",
    repoId: "chat-tag",
    urls: { public: "https://chat-tag-new.fly.dev", api: "https://chat-tag-new.fly.dev/api" },
    interfaces: { oauth: true, events: true, xp: true },
    serviceRoles: { "chat-tag-new": "web", "chat-tag-bot-new": "bot" },
  },
];

function repoName(repoUrl: string): string {
  return repoUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function publicRuntime(value: any, observedAt: string): PublicRuntimeState {
  return {
    status: String(value?.status || "unknown"),
    machineCount: Number.isFinite(value?.machineCount) ? Number(value.machineCount) : null,
    states: value?.states && typeof value.states === "object" ? { ...value.states } : {},
    failingCheckCount: Number.isFinite(value?.failingCheckCount) ? Number(value.failingCheckCount) : null,
    observedAt,
  };
}

function unobservedRuntime(observedAt: string): PublicRuntimeState {
  return {
    status: "unobserved",
    machineCount: null,
    states: {},
    failingCheckCount: null,
    observedAt,
  };
}

export function buildPublicEcosystemSnapshotFromStates(
  flyStates: any,
  options: { generatedAt?: string; producerCommit?: string | null } = {},
): PublicEcosystemSnapshot {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const observationTime = String(flyStates?.generatedAt || generatedAt);
  const repos = new Map(listRepoConfigs().map((repo) => [repo.id, repo]));
  const observed = new Map<string, any>((Array.isArray(flyStates?.apps) ? flyStates.apps : []).map((app: any) => [String(app.appName || ""), app]));
  const apps: Record<string, PublicEcosystemApp> = {};

  for (const declared of DECLARED_APPS) {
    const repo = repos.get(declared.repoId);
    if (!repo) throw new Error(`Missing repository mapping for ecosystem app ${declared.id}: ${declared.repoId}`);
    const services: PublicEcosystemApp["services"] = {};
    for (const flyApp of repo.appNames) {
      const state = observed.get(flyApp);
      services[flyApp] = {
        flyApp,
        role: declared.serviceRoles?.[flyApp] || "service",
        runtime: state ? publicRuntime(state, observationTime) : unobservedRuntime(observationTime),
      };
    }
    apps[declared.id] = {
      id: declared.id,
      name: declared.name,
      lifecycle: declared.lifecycle,
      repository: { name: repoName(repo.repoUrl) },
      urls: { ...declared.urls },
      interfaces: { ...declared.interfaces },
      services,
      provenance: { declaredBy: "rotator-contract", observedBy: "fly-machines-api" },
    };
  }

  return {
    schemaVersion: ECOSYSTEM_SCHEMA_VERSION,
    generatedAt,
    producer: { app: "mtman-machine-rotator", commit: options.producerCommit || null },
    apps,
  };
}

export async function buildPublicEcosystemSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<PublicEcosystemSnapshot> {
  const flyStates = await getManagedFlyAppStates(env);
  return buildPublicEcosystemSnapshotFromStates(flyStates, {
    producerCommit: String(env.BUILD_SHA || env.GITHUB_SHA || "").trim() || null,
  });
}

export async function handleEcosystemSnapshotRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/ecosystem/v1/public.json") return false;
  response.setHeader("access-control-allow-origin", "*");
  if ((request.method || "GET").toUpperCase() !== "GET") {
    response.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }
  try {
    const snapshot = await buildPublicEcosystemSnapshot(env);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30, stale-while-revalidate=120",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "Ecosystem snapshot unavailable", detail: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
