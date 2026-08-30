import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("github-control-inventory runner", () => {
  it("rejects malformed payloads before any Fly call", () => {
    const script = resolve(process.cwd(), "scripts/github-control-inventory.mjs");
    const result = spawnSync(process.execPath, [script, "$(touch /tmp/nope-inventory)"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { ok?: boolean; readOnly?: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.readOnly).toBe(true);
    expect(payload.error).toMatch(/Invalid control payload encoding/);
  });

  it("rejects apps outside the dedicated inventory allowlist before any Fly call", () => {
    const script = resolve(process.cwd(), "scripts/github-control-inventory.mjs");
    const encoded = Buffer.from(JSON.stringify({ command: "inventory", appName: "streamweaver-new" }), "utf8").toString("base64");
    const result = spawnSync(process.execPath, [script, encoded], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: "" },
    });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/approved app/);
    expect(payload.error).toContain("spmt-live");
  });

  it("keeps inventory and snapshot reads separate from generic direct-control mutation plumbing", () => {
    const inventory = readFileSync(resolve(process.cwd(), "scripts/github-control-inventory.mjs"), "utf8");
    const direct = readFileSync(resolve(process.cwd(), "scripts/github-control-direct.mjs"), "utf8");
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/github-rotator-control.yml"), "utf8");

    expect(inventory).toContain("'hearmeout-main'");
    expect(inventory).toContain("'hmo-dj-worker'");
    expect(inventory).toContain("'spmt-live'");
    expect(inventory).toContain("readOnly: true");
    expect(inventory).toContain("['volumes', 'snapshots', 'list', String(volume.id), '--app', appName, '--json']");
    expect(inventory).toContain("snapshotInventoryComplete");
    expect(inventory).toContain("snapshotInventory");
    expect(inventory).toContain("const encodedProbe = Buffer.from(probeFor(profile.kind), 'utf8').toString('base64')");
    expect(inventory).toContain("eval(Buffer.from('${encodedProbe}','base64').toString('utf8'))");
    expect(inventory).toContain("['ssh', 'console', '--app', appName, '--machine', active.id, '--command', fixedCommand, '--quiet']");
    expect(inventory).not.toContain("['machine', 'exec'");
    expect(inventory).not.toContain("snapshots', 'create'");
    expect(inventory).not.toContain("volumes', 'create'");
    expect(inventory).not.toContain("volumes', 'delete'");
    expect(inventory).not.toContain("volumes', 'destroy'");
    expect(inventory).not.toContain("process.env[");
    expect(inventory).not.toContain("payload.path");
    expect(inventory).not.toContain("payload.commandLine");
    expect(direct).not.toContain("'spmt-live'");
    expect(workflow).toContain("github-control-inventory.mjs");
    expect(workflow).toMatch(/rotate\|states\|inventory\|signal/);
  });
});
