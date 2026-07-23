import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/dashboardServer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startServer(extraEnv: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "mountainview-api-token-"));
  tempDirs.push(directory);
  const server = startDashboardServer({
    NODE_ENV: "test",
    PORT: "0",
    MOUNTAINVIEW_DB_FILE: join(directory, "mountainview.db"),
    MOUNTAINVIEW_CONFIG_FILE: join(directory, "mountainview-config.json"),
    MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    ...extraEnv,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("MountainView API token authentication", () => {
  it("rejects protected calls without a valid token and accepts the configured API token", async () => {
    const apiToken = "mountainview-test-api-token";
    const { server, baseUrl } = await startServer({ MOUNTAINVIEW_API_TOKEN: apiToken });
    try {
      const unauth = await fetch(`${baseUrl}/mountainview/api/commands`);
      expect(unauth.status).toBe(401);

      const wrong = await fetch(`${baseUrl}/mountainview/api/commands`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(wrong.status).toBe(401);

      const authed = await fetch(`${baseUrl}/mountainview/api/commands`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect(authed.status).toBe(200);
      expect(await authed.json()).toHaveProperty("commands");

      const admin = await fetch(`${baseUrl}/mountainview/api/admin/integrations`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect(admin.status).toBe(200);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("does not grant access when no API token is configured", async () => {
    const { server, baseUrl } = await startServer({});
    try {
      const empty = await fetch(`${baseUrl}/mountainview/api/commands`, {
        headers: { authorization: "Bearer " },
      });
      expect(empty.status).toBe(401);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
