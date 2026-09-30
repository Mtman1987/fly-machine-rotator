import { expect, it, vi } from "vitest";
import { runRotationOnce } from "../src/rotationRunner.js";

const { rotateApp } = vi.hoisted(() => ({
  rotateApp: vi.fn().mockResolvedValue({
    appName: "streamweaver-new",
    success: true,
    dryRun: false,
    before: [],
    after: [],
    actions: [],
    warnings: [],
  }),
}));

vi.mock("../src/config.js", () => ({
  loadConfig: () => ({
    appNames: ["spmt-llm-worker", "streamweaver-new"],
    flyApiToken: "test-token",
    flyApiHostname: "https://api.machines.dev",
    rotation: {},
  }),
}));
vi.mock("../src/flyClient.js", () => ({ FlyApiClient: class {} }));
vi.mock("../src/rotator.js", () => ({ MachineRotator: class { rotateApp = rotateApp; } }));
vi.mock("../src/discord.js", () => ({ sendDiscordReport: vi.fn() }));

it("never starts the retired LLM worker through rotation, even if it remains in the watch list", async () => {
  await runRotationOnce([], {}, { skipDiscordReport: true });
  expect(rotateApp).toHaveBeenCalledTimes(1);
  expect(rotateApp).toHaveBeenCalledWith("streamweaver-new");
});
