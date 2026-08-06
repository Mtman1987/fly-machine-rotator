# SPMT LLM Worker

This directory is a standalone Fly application. It follows the same pattern as the Discord Stream Hub clip worker and HearMeOut worker: its own container, `fly.toml`, CPU, memory, secrets, health check, and deployment lifecycle.

It does not run inside Fly Machine Rotator and does not consume Rotator, StreamWeaver, or tenant application CPU.

## What this first shell provides

- OpenAI-compatible `POST /v1/chat/completions`
- OpenAI-compatible `POST /v1/embeddings`
- authenticated `GET /v1/models`
- unauthenticated bounded `GET /healthz`
- bearer or `x-spmt-ai-token` service authentication
- request size and timeout limits
- forwarding to an OpenAI-compatible model runtime

This is the protected HTTP shell around the model runtime. The actual runtime can be Ollama, llama.cpp, vLLM, LocalAI, or another OpenAI-compatible server reachable through Fly private networking or running in the same Machine image later.

The default `127.0.0.1:11434` setting expects a model runtime in the same Machine. Until one is included, set `LLM_UPSTREAM_BASE_URL` to a private OpenAI-compatible endpoint.

## Required secret

```bash
fly secrets set --app spmt-llm-worker \
  LLM_WORKER_TOKEN='use-a-long-random-service-token'
```

Optional upstream credentials:

```bash
fly secrets set --app spmt-llm-worker \
  LLM_UPSTREAM_API_KEY='private-upstream-token'
```

Do not share these values with apps or browser clients. The SPMT AI router should hold the worker token and issue narrower short-lived authorization to callers.

## Configuration

- `LLM_UPSTREAM_BASE_URL`: OpenAI-compatible base URL ending in `/v1`
- `LLM_DEFAULT_MODEL`: model inserted when the caller omits `model`
- `LLM_REQUEST_TIMEOUT_MS`: upstream timeout, default 120 seconds
- `LLM_MAX_BODY_BYTES`: maximum JSON request size, default 1 MiB

## Test

```bash
cd llm-worker
npm test
```

## Deploy

Choose an unused Fly app name before the first deployment if `spmt-llm-worker` is unavailable, then update `app` in `fly.toml`.

```bash
cd llm-worker
fly apps create spmt-llm-worker --org mtman-new
fly deploy
```

The initial Fly configuration uses its own performance CPU allocation and 4 GiB RAM. Adjust these independently after measuring the selected model runtime.

## Safety boundary

This worker does not contain GitHub, Fly management, Rotator, or tenant credentials. It accepts only inference-shaped requests and proxies only the allowlisted model routes. Existing paid-provider routes remain unchanged and should remain the fallback path in each application.
