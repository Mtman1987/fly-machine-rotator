# ChatGPT MCP Control

Fly Machine Rotator exposes an authenticated Model Context Protocol endpoint at:

```text
https://<rotator-app>.fly.dev/mcp
```

The endpoint is a narrow owner control bridge into the existing Rotator coding workflow, sanitized Fly observability, and named runtime operations. It does not expose a generic shell, Fly tokens, GitHub tokens, secret values, merge, or deployment.

## Tools

Coding workflow:

- `list_code_references`: list repositories available to the Rotator coder.
- `list_coding_jobs`: list recent jobs and their validation state.
- `create_coding_job`: create an isolated coding workspace and run the repository's configured checks.
- `get_coding_job`: read job status, summary, changed files, and checks.
- `get_coding_job_artifact`: read the exact diff, raw checks, or model response.
- `publish_coding_job`: create a draft PR for a completed job with changes and passing checks. This requires an SPMT admin or owner and never merges or deploys.
- `get_athena_repair_audit`: read persisted Athena repair activity and outcomes.

Owner/admin runtime operations:

- `run_rotation`: run one real tracked Rotator cycle across the configured managed Fly apps. It returns each app's handoff/restart result plus the persisted Rotator runtime state.
- `get_signal_history`: read StreamWeaver's persisted Signal hint history and scheduler state. The caller may specify only a history limit from 1 to 100. The app, files, and executed read operation are hard-coded and cannot be supplied by the caller.

Fly observability, admin/owner only:

- `list_fly_app_states`: read sanitized Machine state and health-check status for every app in `FLY_ROTATOR_APPS`, or one allowlisted app.
- `sample_fly_logs`: sample the live Fly NATS log stream for all managed apps or one allowlisted app. Log text is redacted and bounded to at most 500 entries and a 10-second sample.
- `get_fly_observability_snapshot`: return Machine states and a short live log sample in one call.

SPMT workers:

- `get_spmt_llm_worker_status` and `get_spmt_embedding_worker_status`: read sanitized worker state.
- `provision_spmt_llm_worker` and `provision_spmt_embedding_worker`: idempotently provision the allowlisted workers for an SPMT admin or owner.

Creating a coding job changes only its isolated workspace. Publication remains an explicit, separate call and is rejected unless the job is completed, changed at least one file, and passed every recorded check.

## Coding model cost boundary

The Rotator coding worker uses the self-hosted SPMT LLM whenever `SPMT_LLM_BASE_URL` is configured. The production `fly.toml` points that setting at the private `spmt-llm-worker` service, so normal coding jobs do not require a ChatGPT Codex subscription. The older OpenAI Codex SDK path remains only as compatibility behavior when the self-hosted base URL is absent; keep `SPMT_LLM_BASE_URL` configured if the goal is to avoid OpenAI coding-model spend.

## Authentication

MCP uses the existing SPMT OAuth identity boundary. Use a valid SPMT OAuth access token:

```text
Authorization: Bearer <SPMT access token>
```

The Rotator's authenticated browser session cookies are also accepted by the same identity verifier. The obsolete `x-mcp-control-token` header is intentionally rejected.

The MCP bridge calls the internal coding dashboard through the Rotator's loopback-only worker credential. At startup the Rotator generates that internal process credential when one is not explicitly configured; clients do not need to know or copy it.

Runtime mutation and private operational reads require an SPMT admin or owner identity. Ordinary SPMT members cannot invoke them.

## Fly observability boundary

The Rotator already owns its Fly credentials and direct TypeScript connections inside the Fly runtime:

- Machine state comes from the Fly Machines API through `FlyApiClient`.
- Logs come from a short-lived TypeScript NATS subscription to Fly's `logs.>` stream.
- Signal history is read from the active `streamweaver-new` Machine with a fixed read-only Fly Machine command; no caller-provided app, path, or command is accepted.
- Only apps listed in `FLY_ROTATOR_APPS` / `MANAGED_FLY_APPS` can be queried or rotated.
- Machine config, private IPs, environment variables, and token values are never returned.
- Log messages, health-check output, and rotation error text are passed through the Rotator's redaction layer before MCP returns them.
- State/log tools require an SPMT admin or owner even though they are read-only.

## Safety boundary

The MCP boundary intentionally cannot:

- execute arbitrary commands;
- read arbitrary files, environment variables, or secret values;
- push arbitrary branches;
- merge changes;
- deploy applications;
- select arbitrary Machines for create/stop/restart/delete operations.

`run_rotation` is the one named Machine-mutating operation. It delegates to the Rotator's existing tracked rotation policy, operates only on the configured managed-app allowlist, uses the existing lease/health/volume safeguards, persists the normal runtime record, and accepts no app or Machine ID from the caller.

`get_signal_history` is a fixed read-only operation. It can read only StreamWeaver's two Signal runtime files and exposes only bounded scheduler/history fields.

Draft-PR publication is the only GitHub write: it is a named admin-only tool behind the coding workflow's validation gate. Merge and deployment remain outside MCP.

## Validation

Before merging or deploying:

```bash
npm test
npm run typecheck
npm run build
```

After deployment, verify authentication and tool discovery with an MCP-compatible client. Unauthorized requests must return `401`, member calls to privileged tools must return an error result, and `tools/list` must return only the documented tools.

Useful smoke calls after connecting ChatGPT to the MCP endpoint:

```text
run_rotation {}
get_signal_history {"limit":25}
list_fly_app_states {}
get_fly_observability_snapshot {"errorsOnly":true,"limit":100,"durationMs":2000}
sample_fly_logs {"appName":"streamweaver-new","limit":50,"durationMs":2000}
```

## Rollback

MCP uses the same SPMT identity boundary as the rest of Rotator. Emergency shutdown should disable or remove the public `/mcp` route in the outer gateway. The owner runtime tools are isolated from the existing monitor/auto-rotation loop, so they can also be removed independently without disabling scheduled rotation.
