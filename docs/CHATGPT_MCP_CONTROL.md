# ChatGPT MCP Control

Fly Machine Rotator exposes an optional authenticated Model Context Protocol endpoint at:

```text
https://<rotator-app>.fly.dev/mcp
```

The endpoint is a narrow owner control bridge into the existing Athena Coder workflow. It does not expose a shell, Fly tokens, GitHub tokens, secret values, merge, deployment, or Machine mutation.

## Tools

- `list_code_references`: list repositories available to Athena Coder.
- `list_coding_jobs`: list recent jobs and their validation state.
- `create_coding_job`: create an isolated Codex workspace and run the repository's configured checks.
- `get_coding_job`: read job status, summary, changed files, and checks.
- `get_coding_job_artifact`: read the exact diff, raw checks, or Codex response.
- `publish_coding_job`: create a draft PR for a completed job with changes and passing checks. This requires an SPMT admin or owner and never merges or deploys.
- `get_spmt_llm_worker_status` and `get_spmt_embedding_worker_status`: read sanitized worker state.
- `provision_spmt_llm_worker` and `provision_spmt_embedding_worker`: idempotently provision the allowlisted workers for an SPMT admin or owner.

Creating a coding job changes only its isolated workspace. Publication remains an explicit, separate call and is rejected unless the job is completed, changed at least one file, and passed every recorded check.

## Required Fly secrets

The MCP bridge calls Athena Coder through the private loopback dashboard API. At startup the Rotator generates a root-only process credential in `/tmp` when `CODEX_WORKER_SECRET` is absent, so a normal single-machine deployment needs no extra flag. An explicitly configured `CODEX_WORKER_SECRET` is still honored for installations that require a stable cross-service credential. MCP uses the existing SPMT OAuth configuration to verify callers; there is no separate MCP flag or legacy control token.

## Authentication

Use a valid SPMT OAuth access token:

```text
Authorization: Bearer <SPMT access token>
```

The Rotator's own authenticated browser session cookies are also accepted by the same identity verifier. The obsolete `x-mcp-control-token` header is intentionally rejected.

## Safety boundary

The MCP boundary intentionally cannot:

- execute arbitrary commands;
- read environment variables or secret values;
- push arbitrary branches;
- merge changes;
- deploy applications;
- create, stop, restart, or delete Fly Machines.

Draft-PR publication is the only GitHub write: it is a named admin-only tool behind the repair station's validation gate. Merge and deployment remain outside MCP.

## Validation

Before merging or deploying:

```bash
npm test
npm run typecheck
npm run build
```

After deployment, verify authentication and tool discovery with an MCP-compatible client. Unauthorized requests must return `401`, member calls to privileged tools must return an error result, and `tools/list` must return only the tools documented above.

## Rollback

MCP uses the same SPMT identity boundary as the rest of Rotator. Emergency shutdown should disable or remove the public `/mcp` route in the outer gateway; rotating `CODEX_WORKER_SECRET` independently breaks only the MCP-to-Coder loopback until both internal callers are updated.
