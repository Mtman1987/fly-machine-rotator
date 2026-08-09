import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateStreamWeaverState } from "../src/streamweaverAdminUi.js";

describe("StreamWeaver admin relay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the authenticated request when aggregating sections as GET requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => (
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));
    vi.stubGlobal("fetch", fetchMock);

    const request = {
      method: "POST",
      headers: { authorization: "Bearer current-spmt-session" },
    } as IncomingMessage;

    const sections = await aggregateStreamWeaverState(request, {
      STREAMWEAVER_BASE_URL: "https://streamweaver.example",
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer current-spmt-session",
        },
      });
    }
    expect(Object.values(sections).every((section) => (section as { ok: boolean }).ok)).toBe(true);
  });

  it("uses the canonical Fly origin when no StreamWeaver override is configured", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      requestedUrls.push(String(url));
      return new Response('{}', { status: 200, headers: { "content-type": "application/json" } });
    }));

    await aggregateStreamWeaverState({
      method: "GET",
      headers: { authorization: "Bearer current-spmt-session" },
    } as IncomingMessage, {});

    expect(requestedUrls).toHaveLength(5);
    expect(requestedUrls.every((url) => url.startsWith("https://streamweaver-new.fly.dev/"))).toBe(true);
  });
});
