import { describe, expect, it } from "vitest";
import {
  getQuackverseArtInventory,
  readQuackverseArtAsset,
  quackverseFlyArtPolicy,
  type FlyctlRunner,
} from "../src/quackverseFlyArt.js";

const env = {
  FLY_API_TOKEN: "test-fly-token",
  FLY_ROTATOR_APPS: "chat-tag-new,streamweaver-new",
} as NodeJS.ProcessEnv;

const machineResolver = async () => "machine-123";

describe("Quackverse Fly art reader", () => {
  it("hard-locks the app, volume root, extensions, and read size", () => {
    expect(quackverseFlyArtPolicy).toMatchObject({
      appName: "chat-tag-new",
      root: "/data/quackverse-card-art",
      maxAssetBytes: 8 * 1024 * 1024,
    });
    expect(quackverseFlyArtPolicy.allowedExtensions).toEqual(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
  });

  it("inventories through fly machine exec without accepting app, path, or shell input", async () => {
    let capturedArgs: string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    const runner: FlyctlRunner = async (args, childEnv) => {
      capturedArgs = args;
      capturedEnv = childEnv;
      return {
        stdout: 'noise__QVA_BEGIN__{"root":"/data/quackverse-card-art","assets":[{"fileName":"1/static.webp","size":1234,"sha256":"abc","modifiedAt":"2026-08-12T00:00:00.000Z"}]}__QVA_END__',
        stderr: "",
      };
    };

    const result = await getQuackverseArtInventory(env, runner, machineResolver);
    expect(result).toMatchObject({
      appName: "chat-tag-new",
      machineId: "machine-123",
      root: "/data/quackverse-card-art",
      assetCount: 1,
    });
    expect(capturedArgs.slice(0, 7)).toEqual([
      "machine",
      "exec",
      "--app",
      "chat-tag-new",
      "--timeout",
      "20",
      "machine-123",
    ]);
    expect(capturedArgs).toContain("node");
    expect(capturedArgs).not.toContain("sh");
    expect(capturedArgs).not.toContain("bash");
    expect(capturedArgs.join(" ")).not.toContain("test-fly-token");
    expect(capturedEnv.FLY_API_TOKEN).toBe("test-fly-token");
    expect(capturedEnv.FLY_ACCESS_TOKEN).toBe("test-fly-token");
  });

  it("reads only validated image paths and returns bounded base64 data", async () => {
    const runner: FlyctlRunner = async (args) => {
      expect(args.at(-1)).toBe("4/static.webp");
      return {
        stdout: '__QVA_BEGIN__{"fileName":"4/static.webp","size":3,"mimeType":"image/webp","sha256":"deadbeef","base64":"YWJj"}__QVA_END__',
        stderr: "",
      };
    };

    await expect(readQuackverseArtAsset({ fileName: "4/static.webp" }, env, runner, machineResolver)).resolves.toMatchObject({
      appName: "chat-tag-new",
      machineId: "machine-123",
      fileName: "4/static.webp",
      size: 3,
      mimeType: "image/webp",
      base64: "YWJj",
    });
  });

  it("rejects traversal and non-image requests before invoking Fly", async () => {
    let invoked = false;
    const runner: FlyctlRunner = async () => {
      invoked = true;
      return { stdout: "", stderr: "" };
    };
    await expect(readQuackverseArtAsset({ fileName: "../secrets.txt" }, env, runner, machineResolver)).rejects.toThrow(/Invalid|Unsupported/);
    await expect(readQuackverseArtAsset({ fileName: "notes.txt" }, env, runner, machineResolver)).rejects.toThrow(/Unsupported/);
    expect(invoked).toBe(false);
  });

  it("requires ChatTag to remain in the Rotator managed-app allowlist", async () => {
    await expect(getQuackverseArtInventory(
      { FLY_API_TOKEN: "token", FLY_ROTATOR_APPS: "streamweaver-new" },
      async () => ({ stdout: "", stderr: "" }),
      machineResolver,
    )).rejects.toThrow(/not in the Rotator managed Fly app allowlist/);
  });
});
