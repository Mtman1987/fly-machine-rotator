import { describe, expect, it } from "vitest";
import { isNonActionableErrorMessage, looksLikeError } from "../src/logMonitor.js";

describe("log monitor noise filtering", () => {
  it.each([
    '[API Error] /api/tag: 400 {"error":"tigerflakes420 is immune (20-min cooldown)"}',
    '[API Error] /api/tag: 400 {"error":"You are not it! chronic_medusa is it."}',
    '[Bot] Tag API response: {"error":"You are not it! lippyyybish is it.","__ok":false,"__status":400}',
    '[Bot] Tag API response: {"error":"fultztrain420 is immune (no-tagback)","__ok":false,"__status":400}',
    "[Bot] Tag error: mtman1987 is away/offline",
    "[Bot] Auto-rotate failed (1/3): no other live eligible players",
    "[Bot] Auto-rotate failed 3 times for fatkid4ev4; triggering FFA fallback",
    '[API Error] /api/quackverse/pack: 429 {"packsRemaining":0,"dailyLimit":3}',
    '[PM01] machines API returned an error: "machine still attempting to start"',
    '[PM01] machines API returned an error: "rate limit exceeded"',
    "[PM08] machine is in a non-startable state: stopping",
    '[PM01] machines API returned an error: "machine ID 32870570a60738 lease currently held by 21609dbf-3b65-5861-a8b6-c1dd95cfdd5b@tokens.fly.io, expires at 2026-05-19T05:45:22Z"',
    "[PM05] failed to connect to machine: gave up after 15 attempts (in 8.261252872s)",
    "[PC07] failed to connect to instance after 6 attempts",
    "[PR03] could not find a good candidate within 1 attempts at load balancing. last error: [PM05] failed to connect to machine: gave up after 15 attempts (in 8.199409689s)",
    '[PR03] could not find a good candidate within 1 attempts at load balancing. last error: [PM01] machines API returned an error: "rate limit exceeded"',
    "[PU02] could not complete HTTP request to instance: legacy hyper error: client error (SendRequest), caused by: connection error, caused by: fly-proxy-p2p/tls/http-multihop: connection reset",
    "\u001b[31mERROR\u001b[0m error umounting /data: EBUSY: Device or resource busy, retrying in a bit",
    '[TTS] inworld failed (voice: Snik), falling back to EdenAI: Inworld TTS failed: 402 {"code":7}',
    '[TTS] OpenAI failed (voice: openai:nova), falling back to EdenAI edenai:openai:FEMALE: OpenAI TTS failed: 429 {',
    '[Bot] Join result: {"error":"Already in game","__ok":false,"__status":400}',
    '[API Error] /api/tag: 400 {"error":"Already in game"}',
    '[Bot] Failed joining x3_selegna: msg_banned',
    '[Bot] Auto-blacklisting banned channel: x3_selegna',
    '[Bot] Join failed nrdedan: account exists (id=416571103) but IRC timed out - may have chat disabled, followers-only, or Twitch IRC issue',
    '[Dispatcher] Non-command message from gpplayhouse, checking mentions. lowerMessage: "panic turned 41"',
    "[BRB] Playing clip: All Panic all the time (15.7s) for gpplayhouse"
  ])("ignores expected or non-actionable rotator report noise: %s", (message) => {
    expect(looksLikeError(message)).toBe(false);
  });

  it("ignores Fly platform lifecycle noise", () => {
    const messages = [
      "[PM07] failed to change machine state: machine getting replaced, refusing to start",
      "[PM07] failed to change machine state: unable to start machine from current state: 'created'",
      "ERROR error signaling (SIGTERM) main child process: ESRCH: No such process",
      "2026/07/01 13:42:46 ERROR unexpected error executing command error=\"exec: \"powershell\": executable file not found in $PATH\"",
      "Error: failed to pipe response",
      "⨯ Error: failed to pipe response",
      "  [cause]: TypeError: terminated",
      "    [cause]: Error [SocketError]: other side closed",
      "[PU05] could not finish reading HTTP body from instance: error reading a body from connection",
      "[Kick] ❌ Pusher connection error for fatkid4ev4: { type: 'PusherError', data: { code: 1006, message: undefined } }"
    ];

    for (const message of messages) {
      expect(isNonActionableErrorMessage(message)).toBe(true);
      expect(looksLikeError(message)).toBe(false);
    }
  });

  it("ignores TTS preview lines that only echo failure text", () => {
    const message = "  textPreview: `Oh, my magnificent Commander! \"Failed\"? Oh, Annie's circuits just gave a tiny *f`,";
    expect(looksLikeError(message)).toBe(false);
  });

  it("ignores received-message and banned-channel echoes", () => {
    expect(looksLikeError("[DiscordChat] Received: {\"message\":\"this gives me an error\"}")).toBe(false);
    expect(looksLikeError("[Twitch:community-bot] Failed to join #infuse_carnage: msg_banned")).toBe(false);
  });

  it("keeps real app failures actionable", () => {
    expect(looksLikeError("[Next.js ERROR] [AI Image] Error: Custom SeaArt models require modelNo:modelVerNo.")).toBe(true);
  });

  it.each([
    "Out of memory: Killed process",
    "[18:43] error: Login authentication failed",
    "[XtreamCache] Cache failed for VOD 936395: Xtream cache upstream returned 551",
    "Health check 'servicecheck-00-http-8091' on port 8091 has failed."
  ])("keeps actionable production failures: %s", (message) => {
    expect(looksLikeError(message)).toBe(true);
  });
});
