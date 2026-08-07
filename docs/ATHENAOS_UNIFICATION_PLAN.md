# AthenaOS Unification Plan

## Objective

Transform the current collection of Athena chatbots, memories, prompts, and app-specific integrations into one ecosystem intelligence that:

- has one canonical identity;
- can be reached from Twitch, Discord, AI glasses, MountainView, Rotator, StreamWeaver, and future SPMT apps;
- understands whether a request is public or private;
- lets private conversations use both public and private knowledge;
- prevents public conversations from receiving private knowledge at all;
- remembers where information came from;
- reads and controls SPMT apps through structured tools and natural language;
- maintains separate conversation threads while sharing appropriate long-term knowledge.

This plan assumes four coordinated commits. Because AthenaOS spans multiple repositories, each “commit” should be treated as one atomic implementation stage. Where necessary, a stage may become one synchronized PR per affected repository.

---

# Commit 1 — Establish AthenaOS Core Contracts

## Purpose

Create the canonical AthenaOS request, response, memory, conversation, identity, and tool contracts before moving any live traffic.

## Primary repository

`spmt-live`

## Core work

- Define canonical `AthenaRequest` and `AthenaResponse` envelopes.
- Require every request to include authenticated identity, tenant, visibility, surface, app, channel, conversation ID, audience, live/private status, and reply mode.
- Define supported surfaces such as Twitch, Kick, Discord channels, Discord DMs, StreamWeaver private chat, Rotator, MountainView, AI glasses, voice, and internal services.
- Introduce one source-aware `AthenaMemory` record with:
  - `public` or `private` visibility;
  - memory kind;
  - topic and content;
  - source app, surface, conversation, channel, and message;
  - participants;
  - confidence;
  - timestamps and optional expiration.
- Add a strict pre-retrieval policy:
  - public request → public memory only;
  - private request → public and private memory.
- Create one versioned Athena identity profile covering permanent identity, relationship rules, ecosystem knowledge, public/private behavior, disclosure policy, and tool policy.
- Define small channel overlays instead of separate personalities.
- Define a canonical tool contract with app owner, description, input/output schemas, required scopes, risk classification, and confirmation policy.
- Start a capability registry with read-only tools for ChatTag, StreamWeaver, Discord, Rotator, and SPMT.
- Add contract tests proving visibility enforcement, source preservation, valid surfaces, conversation IDs, tool risk declarations, and identity versioning.

## Acceptance criteria

- Existing Athena endpoints remain unchanged.
- Shared contracts compile.
- Rotator and StreamWeaver can use the same contract definitions.
- Public/private retrieval behavior is unit tested.
- No production traffic has moved yet.

---

# Commit 2 — Build the AthenaOS Gateway and Unified Memory Service

## Purpose

Create one Athena request pipeline and unify the existing memory stores behind one API.

## Primary repository

`spmt-live`, with StreamWeaver initially serving as the physical storage adapter because its public/private stores are already mature.

## Main endpoint

`POST /api/athena/respond`

## Request pipeline

1. Authenticate the caller.
2. Resolve SPMT identity and tenant.
3. Resolve surface and visibility from trusted server context.
4. Verify the caller may use that surface.
5. Load the canonical Athena identity.
6. Retrieve only permitted memories.
7. Retrieve the current conversation thread.
8. Discover relevant tools.
9. Classify intent.
10. Call read tools when appropriate.
11. Select a provider/model.
12. Generate the response.
13. Save the conversation turn.
14. Extract durable memory candidates.
15. Apply visibility and source metadata.
16. Return a structured response with provider, model, sources, and tool results.

## Separate conversation history from durable memory

Create a conversation-turn store containing:

- conversation ID;
- tenant;
- visibility;
- surface;
- user, assistant, or tool role;
- content;
- source message/tool metadata;
- timestamp.

Conversation history answers “what happened in this thread?” Long-term memory answers “what should Athena remember across surfaces?”

## Retrieval rules

### Public requests may use

- public facts and preferences;
- public conversation summaries;
- public app-state summaries;
- public tool results;
- the current public thread.

### Public requests must never use

- private chats or DMs;
- private LTM;
- unreleased project notes;
- private Rotator conversations;
- private operational context.

### Private requests may use

- public memory;
- private memory;
- private and relevant public summaries;
- the current private thread;
- private operational context and tool results.

## Source-aware continuity

Memory injected into the model must retain origin, such as:

- Public · Twitch chat · time
- Private · Rotator workbench · date
- ChatTag · current game state

Athena should say “earlier in Twitch chat” when appropriate and reserve “this conversation” for matching conversation IDs.

## Commander memory migration

- Migrate public-origin records to public summaries.
- Migrate private-origin records to private memory.
- Default uncertain records to private for review.
- Preserve tenant, bot, and timestamp metadata.
- Stop new writes to `commander-memory.json`.
- Keep the old file read-only for one release.

## Memory adapter

Wrap StreamWeaver’s existing:

- public chat store;
- private chat store;
- public/private LTM;
- person notes;
- world lore;
- bot-interaction history.

Expose one common search, write, conversation-read, and conversation-append interface.

## Memory classification

- Inherit visibility from the source.
- Never auto-promote private information to public.
- Allow explicit authenticated publication from private contexts.
- Avoid storing filler.
- Add confidence and optional expiry.
- Deduplicate similar facts.

## Provider routing

Put local Qwen, OpenAI, Eden AI, Gemini, and optional SeaArt Character behind one Athena model interface.

## Acceptance criteria

- `/api/athena/respond` works with synthetic requests.
- Isolation occurs before inference.
- Private Athena can recall public events with correct source wording.
- Public Athena cannot see or reveal private-memory existence.
- Commander migration is available.
- Existing StreamWeaver endpoints still work.

---

# Commit 3 — Convert Rotator and StreamWeaver into AthenaOS Clients

## Purpose

Move active Athena conversational surfaces onto the shared gateway while retaining compatibility.

## Repositories

- `fly-machine-rotator`
- `streamweaver`
- `spmt-live` as needed for service authentication

## Rotator

Change `/athena/api/chat` into an adapter for `/api/athena/respond`.

Send:

- `visibility: private`
- `surface: rotator-workbench`
- stable conversation ID
- authenticated SPMT identity
- optional provider and temperature overrides

Keep UI features such as provider selection, export, worker status, and provisioning. Remove responsibility for Athena’s permanent prompt, memory retrieval, policy, app knowledge, and tool choice.

Add durable conversations, recent-thread navigation, explicit new-conversation behavior, and a visible private-context badge.

## StreamWeaver public

Adapt `/api/ai/chat-with-memory`:

- Twitch → public / twitch-chat
- Twitch cross-bot → public / twitch-chat
- Discord server → public / discord-channel
- Discord cross-bot → public / discord-channel
- Kick → public / kick-chat
- Voice → visibility determined by authenticated session

StreamWeaver continues to own transports, posting, TTS, OBS, overlays, rate limits, and tenant routing. AthenaOS owns reasoning, memory, identity, tools, and generation.

## StreamWeaver private

Adapt `/api/private-chat/respond`:

- `visibility: private`
- `surface: streamweaver-private`
- durable private conversation ID

Private chat should gain both private and public knowledge, including public Twitch/Discord summaries and app events, while maintaining private project and planning memory.

## Compatibility

Keep these routes as adapters:

- `/api/ai/chat-with-memory`
- `/api/private-chat/respond`
- `/athena/api/chat`

Add deprecation logs to find remaining callers.

## Remove duplicate identities

- Remove Rotator’s hardcoded Athena identity.
- Remove duplicate StreamWeaver identity construction.
- Retain only channel-specific overlays and authorized tenant presentation settings.

## End-to-end tests

### Public to private continuity

A Twitch debugging discussion should later be recalled in a Discord DM as “earlier in Twitch chat.”

### Private isolation

A private unreleased badge plan must not be available from Twitch.

### Consistent tool result

“Who’s it in ChatTag?” should return the same facts from Twitch, Discord public, Discord DM, and Rotator, with audience-appropriate wording.

## Acceptance criteria

- Rotator and StreamWeaver use the same Athena identity.
- Private chat uses public and private knowledge.
- Public chat uses public knowledge only.
- Source and conversation boundaries are correct.
- Existing transports and commands continue working.

---

# Commit 4 — Add the SPMT Tool Layer and Cross-Surface Athena Access

## Purpose

Turn Athena into the natural-language operating layer for SPMT.

## Repositories

- `spmt-live`
- `chat-tag`
- `streamweaver`
- `DiscordStreamHub`
- `fly-machine-rotator`
- MountainView / AI glasses bridge

## Tool broker

Add:

- `GET /api/athena/tools`
- `POST /api/athena/tools/execute`

The broker must:

1. verify service identity;
2. verify the user and tenant;
3. enforce required scopes;
4. classify risk;
5. require confirmation when needed;
6. call the owning app;
7. normalize results;
8. redact secrets;
9. audit the request and outcome;
10. return source metadata.

## ChatTag first vertical slice

Add read tools:

- `chattag.game.current`
- `chattag.game.history`
- `chattag.player.status`
- `chattag.player.stats`

A normalized current-state result should include who is it, who tagged them, when, elapsed time, and source metadata.

## StreamWeaver tools

Read:

- health;
- command list/status;
- recent events;
- overlay status;
- bot settings;
- chat summary.

Reversible actions:

- enable/disable a command;
- show/hide an overlay.

## Discord tools

Read:

- recent channel activity;
- message search;
- member lookup;
- bridge status.

Posting, deleting, moderation, and role changes require explicit confirmation and scopes.

## Rotator tools

- worker status/logs;
- repair status/run;
- deployment status.

Repair and deployment actions should require confirmation.

## SPMT tools

- app list and health;
- notifications;
- workspace summary;
- permission explanation;
- recent activity.

## Cross-surface adapters

- Discord DM → private / discord-dm
- Discord server → public / discord-channel
- Twitch → public / twitch-chat
- Rotator → private / rotator-workbench
- MountainView → private authenticated client
- AI glasses → authenticated visibility plus voice reply mode

The glasses response may include short spoken text and a longer display payload.

## Confirmation records

Pending actions should bind:

- authenticated user;
- tenant;
- conversation;
- exact tool and arguments;
- risk;
- expiry.

Example:

“Restart StreamWeaver” becomes a pending action, and “confirm restart” executes only that exact action for the same user.

## Audit logging

Record:

- requester;
- source surface;
- visibility;
- tool;
- redacted arguments;
- authorization;
- confirmation;
- result;
- timestamp;
- source app.

## Athena diagnostics

Add an owner-only dashboard showing:

- identity version;
- provider health;
- memory-store health;
- retrieval policy;
- registered tools;
- recent tool calls;
- integration failures;
- conversations by surface;
- pending confirmations;
- legacy endpoint usage;
- migration status.

## Acceptance criteria

- ChatTag state is queryable consistently from every major surface.
- Facts are identical while wording respects audience.
- Private Athena uses public and private memory.
- Public Athena cannot use private memory.
- At least one reversible action works with confirmation.
- Tool calls are permission checked and audited.

---

# Migration and Rollback Strategy

## Feature flags

- `ATHENA_OS_GATEWAY_ENABLED`
- `ATHENA_OS_ROTATOR_ENABLED`
- `ATHENA_OS_STREAMWEAVER_PUBLIC_ENABLED`
- `ATHENA_OS_STREAMWEAVER_PRIVATE_ENABLED`
- `ATHENA_OS_TOOLS_ENABLED`
- `ATHENA_OS_MEMORY_WRITES_ENABLED`

## Shadow mode

Before switching user-visible responses:

1. Existing endpoint generates the live response.
2. AthenaOS receives the same request in shadow mode.
3. AthenaOS output is logged but not shown.
4. Compare memory retrieval, privacy policy, response consistency, latency, tool selection, and source attribution.

## Memory migration

1. Keep old files intact.
2. Import into source-aware AthenaOS records.
3. Default uncertain Commander records to private.
4. Verify counts and retrieval.
5. Stop writes to legacy stores.
6. Retain read-only rollback for one release.
7. Archive only after validation.

## Rollback

Every client adapter must have a switch back to the current endpoint. AthenaOS must not delete legacy memory during the first release.

---

# Non-Negotiable Security Rules

1. Public requests retrieve public memory only.
2. Private requests may retrieve public and private memory.
3. Visibility comes from trusted server context.
4. The model cannot choose or elevate visibility.
5. Tool permissions are enforced outside the model.
6. Sensitive/destructive actions require confirmation.
7. Tool results retain source metadata.
8. Public responses cannot disclose the existence of private memories.
9. Secrets and tokens are never conversational memory.
10. Cross-tenant memory is denied unless explicitly authorized.
11. Commander identity requires verified account mapping.
12. Continuity uses stable conversation IDs rather than guesses.

---

# Result After Four Commits

- One canonical Athena identity.
- One request gateway.
- One provider-routing layer.
- One tool registry.
- Two memory visibility classes.
- Private Athena can use public and private knowledge.
- Public Athena sees public knowledge only.
- Every memory preserves its origin.
- Every conversation remains distinct.
- Twitch, Discord, Rotator, StreamWeaver, MountainView, and AI glasses reach the same Athena.
- SPMT apps expose structured data and actions.
- Natural language becomes permissioned tool execution.
- New surfaces can be added without creating another Athena chatbot.

AthenaOS becomes the intelligence layer over the full SpaceMountain ecosystem rather than another isolated application.
