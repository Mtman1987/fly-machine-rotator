import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spmtSharedUiHead, spmtSharedUiScript } from "../src/spmtSharedUi.js";

describe("SPMT shared runtime shell", () => {
  it("renders a persistent three-slot Worktray and canonical shared-surface gate", () => {
    const head = spmtSharedUiHead("rotator-home");
    const script = spmtSharedUiScript("rotator-home");

    expect(head).toContain(".spmt-workspace-tray");
    expect(script).toContain("aria-label','SPMT workspace tray");
    expect(script).toContain("[1,2,3].map");
    expect(script).toContain("profile.dockSlots");
    expect(script).toContain("surfaceUrl(state.activeId)");
    expect(script).toContain("['Workspace','worktray']");
    expect(script).toContain("['Overlay Bay','overlays']");
    expect(script).toContain("['Settings','settings']");
    expect(script).not.toContain("https://spacemountain.live");
    expect(script).not.toContain("/?surface=workspace");
    expect(script).not.toContain("/?surface=overlay");
  });

  it("mounts one canonical Personal renderer instead of rebuilding overlay widgets", () => {
    const head = spmtSharedUiHead("athena");
    const script = spmtSharedUiScript("athena");

    expect(script).toContain("personalOverlayUrl");
    expect(script).toContain("data-canonical-personal-overlay");
    expect(script).toContain("f.src=state.personalOverlayUrl");
    expect(head).toContain(".spmt-runtime-overlay iframe{position:absolute;inset:0;width:100%;height:100%");
    expect(script).not.toContain("overlayWorkspace");
    expect(script).not.toContain("overlay.widgets");
    expect(script).not.toContain("f.style.left=Number(w.x||0)+'%'");
  });

  it("keeps the shared tray in framed app views while suppressing only the duplicate Personal renderer", () => {
    const script = spmtSharedUiScript("athena");
    expect(script).toContain("const EMBEDDED=window.self!==window.top");
    expect(script).not.toContain("if(EMBEDDED)return");
    expect(script).toContain("if(EMBEDDED||!state.connected||!state.personalVisible||!state.personalOverlayUrl)return");
    expect(script).toContain("spmt-workspace-tray");
  });

  it("uses scattered stars and SpaceMountain-compatible radii", () => {
    const head = spmtSharedUiHead("athena");
    const script = spmtSharedUiScript("athena");

    expect(head).toContain(".spmt-star-layer");
    expect(head).not.toContain("background-size:170px 170px");
    expect(script).toContain("sm:'12px',md:'18px',lg:'26px',full:'999px'");
  });

  it("injects the same canonical theme artwork used by the suite", () => {
    const patchSource = readFileSync(new URL("../scripts/patch-ecosystem-workspace-parity.mjs", import.meta.url), "utf8");

    expect(patchSource).toContain('id="spmt-suite-background"');
    expect(patchSource).toContain('theme-solar-flare-background.webp');
    expect(patchSource).toContain('theme-nebula-purple-background.webp');
    expect(patchSource).toContain('theme-oceanic-blue-background.webp');
    expect(patchSource).toContain('theme-aurora-green-background.webp');
    expect(patchSource).toContain('var(--spmt-suite-bg-image)');
  });

  it("loads the canonical workspace profile, surface registry, and output URLs", () => {
    const settingsSource = readFileSync(new URL("../src/athenaSettings.ts", import.meta.url), "utf8");

    expect(settingsSource).toContain("/api/workspace-profile");
    expect(settingsSource).toContain("/api/platform/surfaces");
    expect(settingsSource).toContain("/api/personal-overlay-launch");
    expect(settingsSource).toContain("/api/tenant-scene?output=public");
    expect(settingsSource).toContain("personalOverlayUrl");
    expect(settingsSource).toContain("tenantOutputs");
    expect(settingsSource).not.toContain("/api/overlay-workspace");
  });

  it("does not expose an alternate shared-settings write path", () => {
    const settingsSource = readFileSync(new URL("../src/athenaSettings.ts", import.meta.url), "utf8");

    expect(settingsSource).toContain('url.pathname === "/athena/api/settings/shared"');
    expect(settingsSource).toContain("return send(response, 410");
    expect(settingsSource).toContain("edited only through the canonical SPMT surface");
    expect(settingsSource).not.toContain("async function patchShared");
  });

  it("resolves MountainView mobile canonical surfaces and Personal HUD from the SPMT registry", () => {
    const patchSource = readFileSync(new URL("../scripts/patch-ecosystem-workspace-parity.mjs", import.meta.url), "utf8");

    expect(patchSource).toContain("/api/platform/surfaces");
    expect(patchSource).toContain("/api/personal-overlay-launch");
    expect(patchSource).toContain("/api/tenant-scene?output=personal");
    expect(patchSource).toContain("surfaceUrls:");
    expect(patchSource).toContain('buildSurfaceUrl("worktray", "full")');
    expect(patchSource).toContain('buildSurfaceUrl("overlays", "full")');
    expect(patchSource).toContain('buildSurfaceUrl("settings", "full")');
    expect(patchSource).toContain("workspace?.canonical?.surfaceUrls?.[workspaceSurface]");
    expect(patchSource).toContain("spmt:mountainview-mobile:");
    expect(patchSource).toContain("personalOverlayUrl");
    expect(patchSource).not.toContain("https://spmt.live/embed/worktray?mode=full&app=mountainview-mobile");
    expect(patchSource).not.toContain("/api/overlay-workspace");
  });

  it("keeps Android Companion routing scoped to the signed-in workspace tenant", () => {
    const patchSource = readFileSync(new URL("../scripts/patch-ecosystem-workspace-parity.mjs", import.meta.url), "utf8");

    expect(patchSource).toContain('const workspaceIdentity = String(workspace?.tenant ?? "").trim().toLowerCase()');
    expect(patchSource).toContain('const scopedTenant = readText(asRecord(workspaceIdentity), "tenant")');
    expect(patchSource).toContain('const scopedTenant = readText(asRecord(commandWorkspace), "tenant")');
    expect(patchSource).toContain('tenantId: workspaceIdentity');
    expect(patchSource).toContain('username: workspaceIdentity');
  });

  it("allows the web-only Docker build to skip the optional MountainView mobile patch", () => {
    const patchSource = readFileSync(new URL("../scripts/patch-ecosystem-workspace-parity.mjs", import.meta.url), "utf8");

    expect(patchSource).toContain("path === 'mobile/App.tsx'");
    expect(patchSource).toContain("error?.code === 'ENOENT'");
    expect(patchSource).toContain("skipped optional mobile/App.tsx workspace parity patch");
  });
});