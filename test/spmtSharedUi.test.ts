import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spmtSharedUiHead, spmtSharedUiScript } from "../src/spmtSharedUi.js";

describe("SPMT shared runtime shell", () => {
  it("renders a persistent three-slot Worktray instead of embedded editor surfaces", () => {
    const head = spmtSharedUiHead("rotator-home");
    const script = spmtSharedUiScript("rotator-home");

    expect(head).toContain(".spmt-workspace-tray");
    expect(script).toContain("aria-label','SPMT workspace tray");
    expect(script).toContain("[1,2,3].map");
    expect(script).toContain("profile.dockSlots");
    expect(script).toContain("/auth/spmt/login?next=");
    expect(script).not.toContain("/embed/worktray");
    expect(script).not.toContain("/embed/settings");
    expect(script).not.toContain("/embed/overlays");
  });

  it("renders the saved SPMT overlay read-only with percentage coordinates", () => {
    const script = spmtSharedUiScript("athena");

    expect(script).toContain("overlayWorkspace");
    expect(script).toContain("f.style.left=Number(w.x||0)+'%'");
    expect(script).toContain("f.style.top=Number(w.y||0)+'%'");
    expect(script).toContain("w.interactive?'auto':'none'");
  });

  it("uses scattered stars and SpaceMountain-compatible radii", () => {
    const head = spmtSharedUiHead("athena");
    const script = spmtSharedUiScript("athena");

    expect(head).toContain(".spmt-star-layer");
    expect(head).not.toContain("background-size:170px 170px");
    expect(script).toContain("sm:'12px',md:'18px',lg:'26px',full:'999px'");
  });

  it("loads both the canonical workspace profile and saved overlay layout", () => {
    const settingsSource = readFileSync(new URL("../src/athenaSettings.ts", import.meta.url), "utf8");

    expect(settingsSource).toContain("/api/workspace-profile");
    expect(settingsSource).toContain("/api/overlay-workspace");
    expect(settingsSource).toContain("overlayWorkspace:");
  });

  it("allows the web-only Docker build to skip the optional MountainView mobile patch", () => {
    const patchSource = readFileSync(new URL("../scripts/patch-ecosystem-workspace-parity.mjs", import.meta.url), "utf8");

    expect(patchSource).toContain("path === 'mobile/App.tsx'");
    expect(patchSource).toContain("error?.code === 'ENOENT'");
    expect(patchSource).toContain("skipped optional mobile/App.tsx workspace parity patch");
  });
});
