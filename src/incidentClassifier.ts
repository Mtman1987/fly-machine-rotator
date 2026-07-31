import type { StoredErrorEvent } from "./aiFixer.js";
import type { FixRecord } from "./fixStore.js";

export type IncidentDisposition = "expected_user" | "auth_config" | "transient_external" | "code" | "unknown";

export interface IncidentClassification {
  key: string;
  disposition: IncidentDisposition;
  autoFixEligible: boolean;
  reason: string;
}

export function classifyIncident(event: Pick<StoredErrorEvent, "appName" | "message" | "context" | "fingerprint">): IncidentClassification {
  const evidence = [event.message, ...(event.context || [])].join("\n");
  const messageLower = event.message.toLowerCase();
  const lower = evidence.toLowerCase();

  if (event.appName === "chat-tag-bot-new" && messageLower.includes("you are not in the game")) {
    return classification("chat-tag-bot-new:user-not-in-game", "expected_user", "Normal command rejection; the player must join before tagging.");
  }
  if (event.appName === "chat-tag-bot-new" && messageLower.includes("/api/kick/broadcast") && /\b(?:401|unauthorized)\b/.test(messageLower)) {
    return classification("chat-tag-bot-new:kick-broadcast-authorization", "auth_config", "The Chat Tag bot and app disagree on the internal service credential; verify the bot-facing secret contract and keep the StreamWeaver credential separate.");
  }
  if (event.appName === "streamweaver-new" && (
    lower.includes("shared chat source-only send") ||
    messageLower.includes("[sharedchat] source-only send failed") ||
    messageLower.includes("[sharedchat] helix source-only send failed") ||
    messageLower.includes("[sharedchat] broadcaster lookup failed") && /\b401\b/.test(messageLower) ||
    lower.includes("walkonrecovery") && lower.includes("twitch client not available for sending messages")
  )) {
    return classification("streamweaver-new:outbound-shared-chat-delivery", "auth_config", "Shared-chat delivery depends on stored Twitch authorization and must not be patched automatically.");
  }
  if (event.appName === "streamweaver-new" && (
    lower.includes("invalid refresh token") ||
    messageLower.includes("authentication failed; reconnect retries paused until the twitch account is re-authorized") ||
    messageLower.includes("proactive token refresh paused until re-authorized")
  )) {
    return classification("streamweaver-new:twitch-refresh-token-invalid", "auth_config", "The stored tenant Twitch refresh grant is invalid. Pause repeated refresh attempts and require that tenant to re-authorize; a repair model cannot create a valid OAuth grant.");
  }
  if (
    event.appName === "chat-tag-bot-new" &&
    lower.includes("cannot find module './src/lib/chat-tag-crowns'") &&
    lower.includes("module_not_found")
  ) {
    return {
      key: "chat-tag-bot-new:crown-module-packaging",
      disposition: "code",
      autoFixEligible: false,
      reason: "The deployed bot image omitted its crown helper. The current Docker build copies and imports that helper before deployment, so historical occurrences should remain classified without generating a second patch.",
    };
  }
  if (
    event.appName === "chat-tag-new" &&
    messageLower.includes("[quackverse] streamweaver overlay notify failed") &&
    lower.includes("tenantid is required")
  ) {
    return {
      key: "chat-tag-new:quackverse-overlay-tenant",
      disposition: "code",
      autoFixEligible: false,
      reason: "A tenantless pack-open surface called a tenant-scoped StreamWeaver overlay. Skip only the overlay notification when no authoritative tenant exists; do not fail or reroute the pack open.",
    };
  }
  if (
    event.appName === "streamweaver-new" &&
    (messageLower.includes("pushererror") && lower.includes("code: 1006") ||
      messageLower.includes("[multiplatform] event error:") && lower.includes("pushererror") && lower.includes("1006"))
  ) {
    return classification("streamweaver-new:kick-pusher-abnormal-close", "transient_external", "Kick/Pusher closed the websocket without a close frame. Reconnect with bounded backoff and group the wrapper and child error as one transport incident.");
  }
  if (messageLower.includes("[pm07]") && messageLower.includes("machine still active, refusing to start")) {
    return classification(`${event.appName}:fly-machine-already-active`, "transient_external", "Fly rejected a duplicate start while the selected machine was already active. Confirm the running machine remains healthy instead of generating an application patch.");
  }
  if (event.appName === "streamweaver-new" && (
    messageLower.includes("could not resolve chatroom id") ||
    /(?:event error|connection error|error):?\s*\{?\s*$/.test(messageLower) && lower.includes("could not resolve chatroom id")
  )) {
    return classification("streamweaver-new:kick-chatroom-authorization", "auth_config", "The stored tenant Kick grant cannot resolve its broadcaster/chat identity; repair the API contract or re-authorize that tenant instead of generating a code patch from each log echo.");
  }
  if (messageLower.includes("health check") && messageLower.includes("has failed") && messageLower.includes("app is not responding properly")) {
    return classification(`${event.appName}:fly-health-transition`, "transient_external", "Fly observed a health-check transition, commonly during a scheduled restart. Confirm recovery before escalating; a single transition is not a code-fix request.");
  }
  if (
    event.appName === "dsh-clip-worker" &&
    messageLower.includes("protocol error (page.capturescreenshot)") &&
    (messageLower.includes("target closed") || messageLower.includes("session closed")) &&
    lower.includes("sending signal sigterm to main child process")
  ) {
    return classification("dsh-clip-worker:rotation-browser-shutdown", "transient_external", "The active worker machine was terminated during a screenshot capture. Confirm the successor completes later clip cycles; keep screenshot failures without the SIGTERM evidence actionable.");
  }
  if (/^\[\d{2}:\d{2}\] error: (?:ping timeout\.|could not connect to server\. reconnecting in \d+ seconds?\.\.)$/i.test(event.message.trim())) {
    return classification(`${event.appName}:twitch-chat-transport`, "transient_external", "The Twitch IRC client lost its ping or connection and entered its built-in reconnect path. Confirm recovery and group the transport sequence instead of asking the coding model to guess which unrelated service timed out.");
  }
  if (
    /^\[\d{2}:\d{2}\] error: (?:reconnecting in \d+ seconds?\.\.|unable to connect\.)$/i.test(event.message.trim()) ||
    /(?:setup failed|connection error|join failed|failed (?:joining|leaving)).*(?:unable to connect|not connected to (?:the )?server)/i.test(messageLower)
  ) {
    return classification(`${event.appName}:twitch-chat-transport`, "transient_external", "The Twitch IRC client is reporting a reconnect lifecycle echo. Preserve the initiating transport failure, group these retries with it, and confirm the client later reconnects.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("xp award failed") && messageLower.includes("missing required scope: xp:write")) {
    return classification("discord-stream-hub-new:spmt-xp-scope", "auth_config", "The app-bound SPMT credential lacks xp:write. Add only that scope to the existing DiscordStreamHub key and verify the key in place.");
  }
  if (event.appName === "chat-tag-new" && messageLower.includes("xp award failed") && messageLower.includes("missing required scope: xp:write")) {
    return classification("chat-tag-new:spmt-xp-scope", "auth_config", "The app-bound Chat Tag credential lacks xp:write. Add only that scope to the existing key and verify its app binding in place.");
  }
  if (
    event.appName === "discord-stream-hub-new" &&
    lower.includes("eventtype must be a lowercase slug using letters, numbers, or hyphens")
  ) {
    return classification("discord-stream-hub-new:spmt-xp-event-type", "code", "DiscordStreamHub sent a dotted XP event type that violates SPMT's lowercase-hyphen slug contract. Map each XP event to a stable lowercase slug before publishing.");
  }
  if (
    messageLower.includes("connecttimeouterror") ||
    lower.includes("und_err_connect_timeout") ||
    messageLower.includes("typeerror: fetch failed") ||
    messageLower.includes("cycle error: fetch failed") ||
    messageLower.includes("proactive token refresh failed: fetch failed")
  ) {
    return classification(`${event.appName}:outbound-connect-timeout`, "transient_external", "The app could not establish an outbound HTTPS connection during the observed provider/network interruption. Confirm later health and successful traffic before escalating to source changes.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("could not forward shoutout to spacemountain") && messageLower.includes("aborterror")) {
    return classification("discord-stream-hub-new:spacemountain-forward-timeout", "transient_external", "The bounded SpaceMountain shoutout forward was aborted during the network interruption. Confirm later delivery and retry only at the event boundary.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("[discordchat] forum forward request failed: this operation was aborted")) {
    return classification("discord-stream-hub-new:forum-forward-timeout", "transient_external", "The bounded internal forum-forward request exceeded its caller deadline. Preserve the completed Discord forum side effect, bound optional mirror calls, and observe recurrence before changing delivery semantics.");
  }
  if (
    event.appName === "streamweaver-new" &&
    messageLower.includes("[discordstreamhub] admin access check failed") &&
    messageLower.includes("aborted due to timeout")
  ) {
    return classification("streamweaver-new:dsh-admin-access-timeout", "transient_external", "The DSH admin-role route already reads durable synced state first and bounds its Discord fallback. Observe recurrence, but do not propose another source patch from an isolated caller timeout.");
  }
  if (messageLower.includes("login authentication failed")) {
    return classification(`${event.appName}:twitch-chat-authentication`, "auth_config", "Twitch IRC rejected the stored login credential. Repair or refresh the affected account grant; do not generate a source patch or conceal the authentication failure.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("missing broadcaster token or refresh token")) {
    return classification("streamweaver-new:missing-broadcaster-authorization", "auth_config", "A tenant has no usable broadcaster grant. Re-authorize that tenant; do not ask the coding model to manufacture OAuth tokens.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("tts generation failed") && /\b401\b/.test(messageLower)) {
    return classification("streamweaver-new:tts-provider-authorization", "auth_config", "The configured TTS provider rejected its credential. Repair the tenant provider credential or routing configuration.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("fallback tts failed: 401")) {
    return classification("streamweaver-new:legacy-tts-fallback-authorization", "code", "The unauthenticated legacy TTS endpoint no longer accepts requests. Prefer configured provider failover before reaching this last-resort adapter.");
  }
  if (event.appName === "streamweaver-new" && (
    messageLower.includes("key was reported as leaked") ||
    messageLower.includes("api key not valid") ||
    /\b(?:401|403)\b/.test(messageLower) && messageLower.includes("tts")
  )) {
    return classification("streamweaver-new:tts-provider-authorization", "auth_config", "A configured TTS provider rejected or revoked its credential. Rotate the affected key and let the app use its bounded provider fallback; never ask the repair model to invent a credential.");
  }
  if (event.appName === "streamweaver-new" && (
    /\b429\b/.test(messageLower) && messageLower.includes("tts") ||
    messageLower.includes("resource_exhausted") && lower.includes("quota")
  )) {
    return classification("streamweaver-new:tts-provider-quota", "auth_config", "The configured TTS provider exhausted its account quota. Keep the bounded fallback active and repair billing or quota outside the coding model.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("failed to fetch twitch user") && lower.includes("bad identifiers")) {
    return classification("streamweaver-new:twitch-login-normalization", "code", "A chat-derived Twitch login contains punctuation. Normalize and encode the identifier before the Helix lookup.");
  }
  if (event.appName === "streamweaver-new" && /^\[walkon\] twitch profile lookup failed for [a-z0-9_]+:;.*failed to fetch twitch user: bad request/i.test(event.message)) {
    return classification("streamweaver-new:twitch-login-normalization", "code", "A chat-derived Twitch login retained trailing punctuation. Normalize and encode the identifier before the Helix lookup.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("generateleaderboardimage") && messageLower.includes("timeouterror")) {
    return classification("discord-stream-hub-new:leaderboard-render-timeout", "transient_external", "The headless leaderboard renderer missed its bounded selector wait. Confirm the next scheduled render succeeds before changing the renderer.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("seaart task timed out")) {
    return classification("streamweaver-new:seaart-generation-timeout", "transient_external", "SeaArt did not finish the generation within the polling window. Retry with bounded polling and only escalate after repeated terminal timeouts.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("failed to create webhook") && /\b404\b/.test(messageLower)) {
    return classification("streamweaver-new:discord-webhook-unavailable", "auth_config", "The target Discord channel cannot create or expose a webhook. Verify the channel mapping and Manage Webhooks permission; the bot fallback should remain available.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("edenai returned no visible text")) {
    return classification("streamweaver-new:private-chat-empty-provider-response", "code", "The private-chat provider returned no displayable content; retry/fallback and structured content extraction belong in the app adapter.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("seaart character returned no visible text")) {
    return classification("streamweaver-new:private-chat-empty-provider-response", "code", "The private-chat provider returned no displayable content; retry/fallback and structured content extraction belong in the app adapter.");
  }
  if (event.appName === "streamweaver-new" && (
    messageLower.includes("seaart character error: 200 auth token invalid") ||
    messageLower.includes("seaart account token rejected") ||
    messageLower.includes("tourist chat num limit")
  )) {
    return classification("streamweaver-new:seaart-character-authorization", "auth_config", "SeaArt rejected the configured account token or exhausted the anonymous fallback. Refresh the paid account credential; the coding model must not manufacture provider authorization.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("[spmt oauth] callback state rejected")) {
    return classification("streamweaver-new:spmt-oauth-state", "auth_config", "The callback carried an expired, replayed, or mismatched OAuth state. Keep the security rejection visible and have the user restart sign-in.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("failed to mirror outbound twitch message to discord") && messageLower.includes("unknown channel")) {
    return classification("streamweaver-new:discord-mirror-channel", "auth_config", "The tenant's Discord mirror channel no longer exists or is inaccessible. Repair that persisted channel mapping instead of generating a source patch.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("[crew checkin] source fetch failed") && messageLower.includes("legacy crew source returned 404")) {
    return classification("streamweaver-new:crew-source-fallback", "code", "Crew Check-In retained an obsolete legacy URL instead of falling back to the shared Discord guild source.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("[forwardforum] spmt.live forward failed") && messageLower.includes("timeout")) {
    return classification("discord-stream-hub-new:forum-forward-timeout", "transient_external", "The bounded SPMT forum mirror exceeded its caller deadline. Preserve the primary forum side effect and observe retries without generating a code patch from one timeout.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("[tts] lifelike eden voice") && messageLower.includes("operation was aborted")) {
    return classification("streamweaver-new:tts-provider-timeout", "transient_external", "The selected TTS provider exceeded its bounded request window. Keep provider failover active and escalate only after repeated terminal failures.");
  }
  if (event.appName === "streamweaver-new" && (
    (messageLower.includes("failed to create clip") || messageLower.includes("clip creation failed")) &&
    (
      lower.includes("missing scope: clips:edit") ||
      messageLower === "[next.js error] [twitch] failed to create clip: {"
    )
  )) {
    return classification("streamweaver-new:twitch-clip-authorization", "auth_config", "The broadcaster grant lacks clips:edit. Re-authorize the affected tenant with that Twitch scope; code cannot add OAuth authorization.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("[twitchpolling] chat update error: msg_banned")) {
    return classification("discord-stream-hub-new:twitch-channel-banned", "auth_config", "Twitch rejected the bot because it is banned in the polled channel. The channel owner must unban it or remove the mapping.");
  }
  if (event.appName === "discord-stream-hub-new" && /^\[\d{2}:\d{2}\] error: msg_banned$/i.test(event.message.trim())) {
    return classification("discord-stream-hub-new:twitch-channel-banned", "auth_config", "The Twitch chat client repeated the channel-ban rejection without its polling prefix. The channel owner must unban the bot or remove the mapping.");
  }
  if (
    event.appName === "streamweaver-new" &&
    messageLower.includes("[ai chat memory] edenai error: 400") &&
    lower.includes("content rejected due to the violation") &&
    lower.includes("\"code\":\"invalid_parameter\"")
  ) {
    return classification("streamweaver-new:ai-content-policy-rejection", "expected_user", "EdenAI rejected the submitted chat content under its safety policy and StreamWeaver returned its rephrase response. This is a handled user-input outcome, not a code repair.");
  }
  if (
    event.appName === "streamweaver-new" &&
    (
      messageLower.includes("request body exceeded 10mb for /api/discord-media") ||
      messageLower.includes("[discord media api] error: typeerror: failed to parse body as formdata") && lower.includes("/api/discord-media")
    )
  ) {
    return classification("streamweaver-new:discord-media-upload-limit", "code", "Next truncated a valid Discord GIF upload before multipart parsing. Raise the bounded request envelope, enforce a smaller explicit file limit, and return controlled 400/413 responses.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("unexpected variable cfg") && lower.includes("image generation")) {
    return classification("streamweaver-new:image-provider-payload", "code", "The image adapter sent a provider-specific field unsupported by the selected EdenAI route. Normalize the provider payload and retain tested fallback.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("model or endpoint") && lower.includes("does not exist or you do not have access") && lower.includes("image")) {
    return classification("streamweaver-new:image-provider-fallback", "code", "The selected image model is unavailable to the configured provider account. The adapter must retry a supported configured model before returning failure.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("skipping duplicate message")) {
    return classification("streamweaver-new:duplicate-message-suppressed", "expected_user", "The dispatcher intentionally suppressed a duplicate delivery. This is evidence that idempotency worked, not an application defect.");
  }
  if (event.appName === "chat-tag-new" && messageLower.includes("unexpected error executing command") && messageLower.includes("file name too long") && messageLower.includes("echo${ifs}")) {
    return classification("chat-tag-new:operator-shell-probe", "expected_user", "A one-off operator SSH probe was passed without a remote shell and became an invalid executable name. It is not an application runtime defect.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("seaart cli failed") && messageLower.includes("model version mismatch")) {
    return classification("streamweaver-new:seaart-model-version", "code", "A persisted SeaArt model version became stale. Retry the stable fallback model and stop reusing the rejected version.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("cli rejected stale model") && messageLower.includes("retrying with seaart-infinity")) {
    return classification("streamweaver-new:seaart-model-fallback", "expected_user", "The image adapter recognized a stale model and invoked its controlled stable fallback.");
  }
  if (event.appName === "streamweaver-new" && messageLower === "operation failed. please try again later." && lower.includes("seaart")) {
    return classification("streamweaver-new:image-provider-fallback", "code", "The image request exhausted its provider fallback after a rejected model. Keep the specific upstream cause grouped with the adapter failure.");
  }
  if (event.appName === "streamweaver-new" && (
    lower.includes("this key may only publish events for streamweaver") ||
    messageLower === "[next.js error] [spmt] event publish failed {"
  )) {
    return classification("streamweaver-new:spmt-source-app-binding", "code", "A StreamWeaver-owned event was labeled as another source app, violating the app-bound SPMT key contract. Keep the source app as streamweaver and describe the feature surface in payload metadata.");
  }
  if (event.appName === "chat-tag-new" && messageLower.includes("invalid jpeg") && lower.includes("pack-preview")) {
    return classification("chat-tag-new:invalid-pack-preview-art", "code", "A malformed or mislabeled card-art file reached the pack ImageResponse. Validate and normalize art before embedding it, falling back to the card placeholder on decode failure.");
  }
  if (event.appName === "chat-tag-new" && messageLower.includes("expected <div> to have explicit") && lower.includes("pack-preview")) {
    return classification("chat-tag-new:invalid-pack-preview-layout", "code", "The pack ImageResponse contains a multi-child div without an explicit supported display mode. Keep an executable renderer regression test so production Satori layout constraints fail before deployment.");
  }
  if (messageLower.includes("salvaged malformed json payload") || messageLower.includes("[discord chat] invalid json payload")) {
    return classification(`${event.appName}:controlled-malformed-json`, "expected_user", "The route already salvaged or rejected malformed caller JSON; keep the controlled 400 path tested without treating the rejected input as an application crash.");
  }
  if (messageLower.includes("after property value in json") &&
    lower.includes("guildid") && lower.includes("channelid") && lower.includes("messageid") && lower.includes("useravatar")) {
    return classification(`${event.appName}:controlled-discord-chat-json`, "expected_user", "The shared Discord chat route recorded the parser detail while salvaging or rejecting a malformed inbound chat payload; keep the narrow input validation path without generating a webhook or TTS serializer patch.");
  }
  if (event.appName === "chat-tag-bot-new" && messageLower.includes("cannot read properties of null") && messageLower.includes("players")) {
    return classification("chat-tag-bot-new:null-live-announcement-payload", "code", "The periodic live-announcement response can be null and must be validated before reading players.");
  }
  if (event.appName === "hearmeout-main" && messageLower.includes("expected property name") && messageLower.includes("json")) {
    return classification("hearmeout-main:malformed-json-input", "code", "A request path parses malformed JSON without returning a controlled 400 response.");
  }
  if (messageLower.includes("could not establish signal connection") && messageLower.includes("websocket")) {
    return classification(`${event.appName}:websocket-signal-connect`, "transient_external", "The realtime signalling websocket failed to establish. Retry with bounded backoff before treating it as an application defect.");
  }
  if (
    messageLower.includes("peer signaling error") ||
    /(?:incoming|outgoing) media call failed/.test(messageLower) && messageLower.includes("negotiation") ||
    messageLower.includes("websocket connection to") && messageLower.includes("/rtc/")
  ) {
    return classification(`${event.appName}:livekit-peer-signaling`, "transient_external", "LiveKit peer signalling disconnected or failed negotiation. Redact connection credentials, retry with bounded backoff, and group remote participant echoes into one transport incident.");
  }
  if (event.appName === "hearmeout-main" && messageLower.includes("discord activity invite failed") && (messageLower.includes("unknown channel") || /\b404\b/.test(messageLower))) {
    return classification("hearmeout-main:discord-activity-channel", "auth_config", "The requested Discord voice channel is stale, inaccessible, or not a voice channel. Fall back to the normal Activity URL instead of patching credentials or retrying the invalid channel.");
  }
  if (event.appName === "hearmeout-main" && messageLower.includes("failed to find server action") && messageLower.includes("older or newer deployment")) {
    return classification("hearmeout-main:stale-server-action-client", "transient_external", "A browser used a Server Action identifier from a different deployment. Refresh the stale client and observe recurrence; no source patch can make two build-specific action identifiers identical.");
  }
  if (event.appName === "hearmeout-main" && messageLower.includes("api key not valid") && messageLower.includes("generativelanguage.googleapis.com")) {
    return classification("hearmeout-main:gemini-api-authorization", "auth_config", "Google rejected the configured Gemini API key. Replace or correct the server-side credential; never ask the repair model to invent a key.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("chat history channel is unavailable")) {
    return classification("streamweaver-new:discord-history-channel", "auth_config", "The configured Discord history channel is missing or inaccessible; continue without history and repair the tenant channel mapping or bot permissions.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("pusher connection error") && (lower.includes("code: 4200") || lower.includes("reconnect immediately"))) {
    return classification("streamweaver-new:kick-pusher-reconnect", "transient_external", "Kick/Pusher requested an immediate reconnect as part of its normal connection lifecycle; reconnect once without emitting an application-error cascade.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("[eventsub:") && messageLower.includes("socket closed: 4002") && messageLower.includes("failed ping pong")) {
    return classification("streamweaver-new:eventsub-ping-timeout", "transient_external", "Twitch EventSub closed a websocket after a missed ping/pong. Reconnect with bounded backoff and group the lifecycle event instead of proposing an unrelated application patch.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("[sharedchat] join before send failed") && messageLower.includes("msg_banned")) {
    return classification("streamweaver-new:shared-chat-channel-banned", "auth_config", "Twitch rejected the shared-chat bot because it is banned in the target channel. The channel owner must unban or remove that mapping; code cannot override the channel permission.");
  }
  if (event.appName === "streamweaver-new" && messageLower.includes("[discord cleanup] message delete failed") && /\b404\b/.test(messageLower) && messageLower.includes("unknown message")) {
    return classification("streamweaver-new:discord-cleanup-already-deleted", "expected_user", "Discord reports that the cleanup target was already deleted. Treat the idempotent cleanup result as complete and do not generate a repair patch.");
  }
  if (messageLower.includes("no response from twitch")) {
    return classification(`${event.appName}:twitch-no-response`, "transient_external", "Twitch IRC did not answer within the client timeout. Retry with bounded reconnect handling and group repeated transport echoes.");
  }
  if (event.appName === "chat-tag-bot-new" && messageLower.includes("channel:bot scope")) {
    return classification("chat-tag-bot-new:twitch-channel-bot-authorization", "auth_config", "The broadcaster grant lacks channel:bot or the bot is not recognized as a moderator. Repair the Twitch grant or moderator relationship; do not generate code or hide the failure.");
  }
  if (messageLower.includes("error: aborted") || messageLower === "⨯ error: aborted") {
    return classification(`${event.appName}:request-aborted`, "transient_external", "The caller closed the request before completion; keep only repeated failures that survive bounded client retry.");
  }
  if (/\[(?:pp|pu)\d+\]/i.test(event.message) && (messageLower.includes("connection reset") || messageLower.includes("broken pipe"))) {
    return classification(`${event.appName}:fly-proxy-connection-reset`, "transient_external", "Fly proxy transport reset a connection. Keep it observable only when bounded client retry also fails.");
  }
  if (messageLower.includes("unexpected error replying to request") && messageLower.includes("error=eof") && messageLower.includes("ok=true")) {
    return classification(`${event.appName}:fly-client-disconnect`, "transient_external", "The client disconnected after Fly had completed the request. Keep recurrence observable, but do not infer an application defect from the EOF with ok=true.");
  }
  if (/\[pu02\]/i.test(event.message) && (
    messageLower.includes("http2 error") ||
    messageLower.includes("stream no longer needed") ||
    messageLower.includes("could not complete http request to instance")
  )) {
    return classification(`${event.appName}:fly-proxy-http2-cancellation`, "transient_external", "Fly proxy cancelled an HTTP/2 request stream after the client no longer needed it. Observe recurrence, but do not infer an application fetch bug from the proxy cancellation alone.");
  }
  if (event.appName === "discord-stream-hub-new" && (
    messageLower.includes("failed to edit message") || messageLower.includes("message update failed")
  ) && /\b(?:500|502|503|504)\b/.test(messageLower)) {
    return classification("discord-stream-hub-new:message-edit-5xx", "transient_external", "Discord returned a retryable 5xx response; retry and observe before proposing code.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("signature verification failed")) {
    return classification("discord-stream-hub-new:signature-verification", "auth_config", "A failed Discord signature check is a security signal and must remain visible; verify the public key, raw request body, and timestamp handling.");
  }
  if (event.appName === "discord-stream-hub-new" && messageLower.includes("body is unusable") && messageLower.includes("already been read")) {
    return { key: "discord-stream-hub-new:request-body-double-read", disposition: "code", autoFixEligible: true, reason: "The route consumed a request body twice while attempting its JSON fallback; parse a single captured body instead." };
  }
  if (event.appName === "hmo-dj-worker" && /sign in to confirm you(?:'|’|‘)re not a bot/.test(messageLower)) {
    return classification("hmo-dj-worker:youtube-bot-challenge", "auth_config", "YouTube challenged the server-side extractor; refresh the authorized extraction path or use the browser-resolved upload/cache handoff.");
  }
  if (event.appName === "hmo-dj-worker" && messageLower.includes("no youtube") && messageLower.includes("stream")) {
    return classification("hmo-dj-worker:youtube-source-unresolved", "transient_external", "The external source resolver returned no playable stream; retry through the browser-resolved handoff and keep the failure visible if all fallbacks fail.");
  }
  if (event.appName === "hmo-dj-worker" && messageLower.includes("[voicebridge] start failed") && /\b429\b/.test(messageLower)) {
    return classification("hmo-dj-worker:livekit-voice-bridge-rate-limit", "transient_external", "LiveKit rate-limited VoiceBridge signalling. Retry with bounded backoff and leave the bridge off until the provider accepts a new connection.");
  }
  if (event.appName === "hmo-dj-worker" && messageLower.includes("[voicebridge] start failed") && messageLower.includes("unknown channel")) {
    return classification("hmo-dj-worker:discord-voice-channel", "auth_config", "The configured Discord voice channel is missing or inaccessible. Select a valid voice channel or repair the stored mapping; code cannot join an unknown channel.");
  }
  if (/\b(?:429|too many requests)\b/.test(messageLower) && messageLower.includes("twitch")) {
    return classification(`${event.appName}:twitch-rate-limit`, "transient_external", "Twitch rate limiting needs shared caching, request coalescing, and bounded backoff; it must not be hidden as noise.");
  }
  if (event.appName === "chat-tag-new" && lower.includes("[announce]") && (
    lower.includes("discord webhook failed") ||
    lower.includes("failed to fetch/embed image") ||
    lower.includes("unknown scheme")
  )) {
    return classification("chat-tag-new:discord-announce-delivery", "transient_external", "The Discord announce retry and attachment fallback form one external-delivery incident.");
  }
  if (/\b(?:500|502|503|504)\b/.test(messageLower) || messageLower.includes("server error")) {
    return classification(`${event.appName}:upstream-5xx`, "transient_external", "An upstream 5xx remains observable until bounded retries succeed or the dependency recovers.");
  }
  if (messageLower.includes("powershell") && messageLower.includes("executable file not found")) {
    return classification(`${event.appName}:platform-command-mismatch`, "code", "The deployed Linux runtime attempted to invoke a Windows-only executable.");
  }
  if (/\b(?:syntaxerror|referenceerror|typeerror)\b/i.test(event.message) && /(?:\/app\/|src\/|src\\)/i.test(evidence)) {
    return { key: `${event.appName}:code:${event.fingerprint}`, disposition: "code", autoFixEligible: true, reason: "A source-backed runtime exception is eligible for a gated code proposal." };
  }
  return classification(`${event.appName}:unknown:${event.fingerprint}`, "unknown", "The incident has not been deterministically classified as code-owned.");
}

export function evaluateAutoFixEligibility(event: StoredErrorEvent, record: FixRecord): { eligible: boolean; reasons: string[] } {
  const incident = classifyIncident(event);
  const reasons: string[] = [];
  if (!incident.autoFixEligible) reasons.push(incident.reason);
  if (record.changes.length === 0) reasons.push("The proposal contains no file changes.");
  if (record.changes.length > 4) reasons.push("The proposal changes more than four files.");
  if (record.changes.some((change) => !change.reason.trim())) reasons.push("Every changed file must include a reason.");
  if ((record.confidenceScore ?? 0) < 75 && record.confidence !== "high") reasons.push("Root-cause confidence is below the automatic-apply threshold.");
  if (!record.repoSnapshot?.headCommit || record.repoSnapshot.dirty) reasons.push("The proposal is not based on a clean captured commit.");
  if (!record.qualityGate || !["ready", "verified"].includes(record.qualityGate.verdict)) {
    reasons.push("The proposal quality gate must be ready or verified before automatic application.");
  }
  return { eligible: reasons.length === 0, reasons };
}

function classification(key: string, disposition: IncidentDisposition, reason: string): IncidentClassification {
  return { key, disposition, autoFixEligible: disposition === "code", reason };
}
