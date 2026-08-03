# Athena Codex Repair Station

The public `!mtfixit <problem>` command is accepted by StreamWeaver, passed through SPMT, and executed by the Fly Machine Rotator in an isolated repository sandbox. Public chat receives only a generic acknowledgment; when the requester is not Mtman1987, StreamWeaver sends the configured owner DM channel a compact report and the SPMT-authenticated repair-station link.

## Trust boundaries

- StreamWeaver knows only `SPMT_CODEX_SERVICE_SECRET`.
- SPMT knows only `CODEX_WORKER_SECRET` and proxies owner/admin reads.
- The rotator owns `OPENAI_API_KEY`; the key is never sent to chat, StreamWeaver, SPMT clients, or the sandbox.
- Codex runs with `workspace-write`, approval policy `never`, disabled network/web search, and a minimal environment.
- Codex cannot push, merge, deploy, change permissions, or access directories outside its assigned sandbox.
- Jobs, diffs, checks, responses, sandboxes, and ecosystem references persist under `/data/codex-fixer` on `rotator_data`.

## Required Fly secrets

Generate two different high-entropy values and configure the same value on both sides of each boundary:

```text
streamweaver-new: SPMT_CODEX_SERVICE_SECRET
spmt-live:        SPMT_CODEX_SERVICE_SECRET

spmt-live:        CODEX_WORKER_SECRET
mtman-machine-rotator: CODEX_WORKER_SECRET

mtman-machine-rotator: OPENAI_API_KEY
```

The rotator also requires its existing `MOUNTAINVIEW_CLIENT_SECRET` and `MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY` secrets so the root dashboard can authenticate through SPMT OAuth. Do not commit any secret to GitHub or place it in a public environment variable.

## Endpoints

SPMT control plane:

- `POST /api/athena/code-jobs`
- `GET /api/athena/code-jobs/:id`
- `GET /api/athena/code-jobs/:id/{diff|checks|response}`
- `GET /api/athena/code-references`

Private rotator worker:

- `POST /api/codex/jobs`
- `GET /api/codex/jobs/:id`
- `GET /api/codex/jobs/:id/{diff|checks|response}`
- `GET /api/codex/references`

The operator UI is `https://mtman-machine-rotator.fly.dev/`. It redirects through SPMT OAuth and requires an SPMT administrator session.

## Athena GPT and operator CLI

The Custom GPT Action schema is maintained in `spmt-live` at `docs/developers/ATHENA_GPT_ACTION_OPENAPI.yaml`. Configure the Action with the existing `SPMT_CODEX_SERVICE_SECRET` using the `x-spmt-codex-secret` header. Athena can submit jobs, read diffs/checks/responses, and—after explicit owner approval—publish a completed job as a draft pull request. It cannot merge or deploy through this Action; merging to `main` remains the release boundary and the existing GitHub Action performs the Fly deployment.

The same gateway can be used from a terminal without exposing Fly, GitHub, or OpenAI credentials locally:

```bash
SPMT_CODEX_SERVICE_SECRET='existing-secret' npm run athena -- repos
SPMT_CODEX_SERVICE_SECRET='existing-secret' npm run athena -- submit streamweaver-new "Describe the requested fix"
SPMT_CODEX_SERVICE_SECRET='existing-secret' npm run athena -- status <job-id>
SPMT_CODEX_SERVICE_SECRET='existing-secret' npm run athena -- publish <job-id>
```
