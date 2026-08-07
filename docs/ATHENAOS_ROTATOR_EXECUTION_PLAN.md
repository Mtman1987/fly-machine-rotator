# AthenaOS Rotator Execution Plan

This document converts the consolidated AthenaOS unification plan into an implementation map for `Mtman1987/fly-machine-rotator`.

It deliberately separates work Rotator can own from contracts that must land in `spmt-live` or StreamWeaver first. Rotator must not invent a second version of those authority contracts locally.

## Target state

Rotator becomes a private AthenaOS client and operations surface, not a second Athena brain.

Rotator should own:

- private operator/workbench presentation;
- worker health and provisioning;
- Athena Coder repair sandboxes and review UX;
- Rotator read tools and confirmation-gated repair/deploy actions;
- local-LLM worker lifecycle;
- diagnostics that report AthenaOS state without duplicating its policy.

Rotator should not own:

- Athena's permanent identity prompt;
- cross-surface memory policy;
- canonical user/tenant identity mapping;
- a separate tool registry;
- visibility classification chosen by the model;
- unconfirmed sensitive writes.

## Current verified baseline

Already present in this repository:

- local llama.cpp worker provisioning and a local provider path;
- Athena workbench/provider controls;
- MCP control-server/tool-broker foundations;
- error ingestion, repair records, editable fixes, checks, branch pushes, and verification;
- Codex repair sandboxes with network disabled;
- MountainView admin sessions;
- redaction helpers;
- repo mappings and validation commands;
- a dashboard with repair and operations data.

Known Rotator P0 items from the consolidated plan:

- dashboard mutations must be owner-authenticated and action-scoped;
- browser writes need request-origin/CSRF protection;
- generated source/log output must stay behind owner authentication;
- sensitive data must be redacted before leaving the private boundary;
- authenticated Git remotes must not persist tokens in volume state;
- sensitive repair/deploy actions must require explicit confirmation;
- action authorization must eventually bind requester, repo/app, operation, commit/input, and expiry.

## Stage R0 — Make Athena Coder operational and owner-safe

Status: **in progress on `codex/athena-plan-coder-workspace`**.

### Required behavior

1. Provide an owner-only Coder workspace at `/athena/coder`.
2. Keep worker-secret authentication for service-to-service job submission.
3. Permit an authenticated MountainView owner session to perform browser Coder writes only when the request is same-origin and explicitly marked as a Coder UI request.
4. Expose a read endpoint for recent jobs to the owner UI.
5. Show, per repair:
   - status;
   - repository/app;
   - Athena/Codex response;
   - changed files;
   - exact diff;
   - validation commands and pass/fail state;
   - failure details;
   - draft PR state.
6. Permit publication only for completed jobs with at least one changed file and all recorded checks passing.
7. Protected deployment/workflow paths remain manual-review only.
8. Publishing creates a **draft** PR. It never merges or deploys.
9. Apply private/no-store headers, CSP, clickjacking protection, and no-sniff headers to the owner workspace/artifacts.

### Acceptance

- A logged-in owner can open `/athena/coder` and inspect a job without possessing `CODEX_WORKER_SECRET`.
- An unauthenticated user is redirected to MountainView login.
- A browser POST without a valid owner session or same-origin Coder marker is rejected.
- Worker-secret callers continue to work.
- A failed/unvalidated repair cannot be published.
- A validated repair can create exactly one draft PR and the UI then links to it.

## Stage R1 — Close the general dashboard control-plane gap

Primary file: `src/dashboardServer.ts`.

### Work

- Replace any broad/no-op dashboard action authorization with verified owner authorization.
- Add a same-origin/CSRF boundary for every dashboard POST action.
- Classify actions:
  - read-only;
  - reversible write;
  - sensitive write.
- Add confirmation records for sensitive actions. A confirmation record must bind:
  - authenticated owner;
  - exact action;
  - repo/app;
  - fix/commit/input identifier where applicable;
  - expiry;
  - one-time use.
- Add rate limiting for mutation endpoints.
- Add append-only audit events with redacted arguments and outcomes.
- Keep logs, proposed source, diffs, validation output, and repair history owner-only.

### Acceptance

- Anonymous POSTs receive 401/403.
- Cross-site POSTs fail.
- A confirmation for one action cannot authorize another.
- Replaying an expired/used confirmation fails.
- Audit records identify requester, action, target, result, and timestamp without secrets.

## Stage R2 — Harden repository credentials and outbound context

Primary files: `src/repoOps.ts`, `src/aiFixer.ts`, `src/publicCodexFixer.ts`, redaction/auth helpers.

### Work

- Ensure authenticated clone/push URLs are not persisted as credential-bearing Git remotes.
- Prefer ephemeral credential injection for network Git operations.
- Run redaction on error context, generated context, logs, and memory-like context before paid-provider requests.
- Add tests with synthetic API keys, bearer tokens, GitHub PATs, emails, and private-looking values.
- Keep the Codex sandbox environment minimal; do not pass the host environment wholesale.

### Acceptance

- A post-operation inspection of `.git/config` contains no token.
- Synthetic secrets do not appear in captured provider request bodies.
- Coder subprocess environment does not contain unrelated host secrets.

## Stage R3 — Convert Rotator chat into an AthenaOS client

Blocked until the authority gateway/contracts exist in `spmt-live`.

### Authority dependencies

Rotator must consume, not redefine:

- canonical `AthenaRequest` / `AthenaResponse`;
- deterministic SPMT visibility to `public | private` mapping;
- `tenantId <-> spmtUserId` identity mapping;
- request-id idempotency rules;
- canonical identity version;
- gateway/service authentication contract.

### Rotator adapter

Convert `/athena/api/chat` into an adapter for the AthenaOS gateway and send server-trusted fields equivalent to:

- `visibility: private`;
- `surface: rotator-workbench`;
- stable conversation ID;
- authenticated SPMT user identity and roles;
- tenant;
- request ID;
- optional owner-authorized provider/temperature override.

Rotator then stops constructing permanent Athena identity, retrieving global memory, or deciding tool policy locally.

### UI

Keep:

- provider controls when authorized;
- local-worker status/provisioning;
- export;
- recent conversation navigation;
- explicit new conversation;
- visible **Private** context badge;
- source attribution returned by AthenaOS.

### Rollback

Gate the adapter with `ATHENA_OS_ROTATOR_ENABLED`; retain the current path for one release.

## Stage R4 — Generalize local worker provisioning for embeddings

Primary file: `src/flyLlmProvisioner.ts`.

### Work

Generalize the provisioner so worker definition is parameterized rather than hardcoded to the chat model:

- app name (still restricted to `spmt-*`);
- Fly config/dockerfile path;
- volume name;
- region;
- CPU/RAM sizing;
- model/alias variables;
- secret names.

Use that to provision a separate small CPU embeddings worker and set/consume `SPMT_EMBED_BASE_URL`.

Rotator does not become the memory/vector database. It only provisions and diagnoses the worker used by the authority/memory service.

## Stage R5 — Athena tools through the existing broker

Primary foundation: `src/mcpControlServer.ts` plus the shared Athena tool contract from `spmt-live`.

Do **not** create another registry.

Start with Rotator read tools:

- worker status;
- worker logs (redacted, scoped);
- repair status;
- deployment status;
- recent repair validation results.

Then add confirmation-gated writes only after R1 is complete:

- run repair;
- publish validated draft repair PR;
- worker restart/rotation where appropriate;
- deployment action only with the strictest confirmation/scope.

Every result should include source metadata suitable for AthenaOS attribution.

## Stage R6 — Athena diagnostics

Expand the owner diagnostics view to show authority-provided state plus Rotator-local health:

- Athena identity version;
- provider/local-worker health;
- memory-store health reported by the gateway;
- active retrieval policy/version;
- registered tools;
- recent tool calls;
- integration failures;
- conversations by surface (metadata, not private text dumps by default);
- pending confirmations;
- legacy endpoint usage;
- migration/feature-flag state;
- Coder queue health.

Diagnostics are observational. They must not become another policy source.

## Cross-repository sequence

### Authority stage A1 — `spmt-live`

Must land first:

- core Athena contracts;
- visibility mapping;
- identity/tenant mapping;
- gateway authentication;
- request-id dedup contract;
- canonical identity version.

### Memory/gateway stage A2 — `spmt-live` + StreamWeaver adapter

- `/api/athena/respond`;
- pre-inference public/private memory isolation;
- source-aware memory/conversation records;
- durable conversation IDs;
- redaction, rate limit, timeout/degraded behavior;
- local-provider routing for non-live workloads;
- RAG/embeddings with tenant and visibility isolation.

### Client stage A3

- Rotator private adapter (R3);
- StreamWeaver public/private adapters;
- legacy route deprecation telemetry;
- shadow-mode comparison before switching visible traffic.

### Tool stage A4

- shared tool contracts layered over existing brokers;
- read tools first;
- confirmation-gated reversible/sensitive writes only after each owning app closes its P0 control-plane issues.

## Required end-to-end tests

The release is not complete until these pass across the participating repositories:

1. **Public to private continuity** — a public Twitch debugging discussion is recalled later in a private surface with Twitch source wording.
2. **Private isolation** — a private Rotator plan is not retrievable or discoverable from public chat.
3. **Tenant isolation** — tenant A private memory never appears for tenant B.
4. **Visibility mapping** — every SPMT visibility maps deterministically; `creator`/`community` are not silently dropped.
5. **Idempotency** — replayed request IDs do not double-write memory or double-post.
6. **Provider redaction** — synthetic secrets/PII never leave in paid-provider bodies.
7. **Degraded mode** — gateway timeout/500 produces a safe transport fallback rather than a crash.
8. **Consistent tool facts** — the same ChatTag state queried from Twitch, Discord public, DM, and Rotator returns identical facts with audience-appropriate wording.
9. **Coder publication gate** — only a validated repair can create a draft PR; merge/deploy remain explicit owner operations.
10. **Dashboard control plane** — anonymous/cross-site mutations and confirmation replay are rejected.

## Feature flags / rollout

Keep the plan's staged flags:

- `ATHENA_OS_GATEWAY_ENABLED`
- `ATHENA_OS_ROTATOR_ENABLED`
- `ATHENA_OS_STREAMWEAVER_PUBLIC_ENABLED`
- `ATHENA_OS_STREAMWEAVER_PRIVATE_ENABLED`
- `ATHENA_OS_TOOLS_ENABLED`
- `ATHENA_OS_MEMORY_WRITES_ENABLED`

Roll local providers to the owner/dev tenant first. Keep live non-command Twitch/Kick responses on the fast paid path until measured latency proves otherwise.

## Definition of done for Rotator

Rotator is complete for AthenaOS when:

- the Coder repair station is owner-usable, reviewable, and cannot silently publish unsafe work;
- dashboard mutations are authenticated, same-origin protected, scoped, rate-limited, confirmation-gated where sensitive, and audited;
- repo/provider secret handling passes redaction and persistence tests;
- `/athena/api/chat` is only a compatibility adapter into the canonical AthenaOS gateway;
- Rotator no longer owns a duplicate permanent Athena identity or memory policy;
- local chat and embeddings workers can be provisioned/diagnosed without coupling memory policy to Rotator;
- Rotator capabilities are exposed through the existing broker using the shared Athena tool contract;
- legacy behavior remains feature-flagged for rollback through the first production release.
