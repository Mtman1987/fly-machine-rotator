import { expect, it, vi } from "vitest";
import { runRotationOnce } from "../src/rotationRunner.js";
const { rotateApps } = vi.hoisted(() => ({ rotateApps: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({ appNames: ["spmt-llm-worker", "streamweaver-new"], rotation: {} }) }));
vi.mock("../src/flyClient.js", () => ({ FlyApiClient: class {} }));
vi.mock("../src/rotator.js", () => ({ MachineRotator: class { rotateApps = rotateApps; } }));
vi.mock("../src/discord.js", () => ({ sendDiscordReport: vi.fn() }));
it("never starts the retired LLM worker through rotation, even if it remains in the watch list", async () => {
  await runRotationOnce([], {}, { skipDiscordReport: true });
  expect(rotateApps).toHaveBeenCalledWith(["streamweaver-new"]);
});
