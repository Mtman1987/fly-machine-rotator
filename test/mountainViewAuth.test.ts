import { describe, expect, it } from "vitest";
import {
  parseCookies,
  renderMobileAuthHandoff,
  renderMountainViewHtml,
  safeSecretEqual
} from "../src/mountainView.js";

describe("MountainView SPMT authentication", () => {
  it("compares OAuth state without accepting missing or partial values", () => {
    expect(safeSecretEqual("state-value", "state-value")).toBe(true);
    expect(safeSecretEqual("state-value", "state-other")).toBe(false);
    expect(safeSecretEqual("", "state-value")).toBe(false);
  });

  it("reads HttpOnly session and OAuth cookies", () => {
    expect(parseCookies("mountainview_session=session%20token; mountainview_oauth_state=state")).toEqual({
      mountainview_session: "session token",
      mountainview_oauth_state: "state"
    });
  });

  it("renders an SPMT login without the retired password or browser token storage", () => {
    const page = renderMountainViewHtml();
    expect(page).toContain("Sign in with SPMT");
    expect(page).not.toContain("MountainView owner password");
    expect(page).not.toContain("localStorage.mvToken");
  });

  it("hands a mobile session directly to the native WebView bridge", () => {
    const page = renderMobileAuthHandoff("token-with-<unsafe>");
    expect(page).toContain("ReactNativeWebView");
    expect(page).not.toContain("token-with-<unsafe>");
    expect(page).toContain("\\u003cunsafe>");
  });
});
