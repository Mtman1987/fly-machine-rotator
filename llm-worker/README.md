# SPMT LLM Worker

This directory deploys a real CPU-hosted LLM as a separate Fly application. It does not run inside Fly Machine Rotator, StreamWeaver, or another tenant app.

The worker uses the official llama.cpp server image and downloads:

- repository: `Qwen/Qwen3-4B-GGUF`
- quantization: `Q4_K_M`
- API model alias: `spmt-qwen3-4b`
- approximate model download: 2.5 GB

The downloaded GGUF is cached on the persistent `spmt_llm_models` Fly Volume at `/models`, so ordinary restarts do not download it again.

## Routes

llama.cpp provides OpenAI-compatible routes including:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `GET /metrics`

Requests other than public health endpoints require the `LLAMA_API_KEY` secret.

## Initial sizing

The first configuration uses its own:

- 8 performance CPUs
- 16 GB RAM
- 10 GB persistent volume
- one always-running Machine
- 8,192-token context
- two parallel request slots

This is intentionally conservative for reliable CPU testing. Reduce CPU/RAM only after measuring latency and memory under actual StreamWeaver bot concurrency.

## Create and deploy

From the repository root:

```bash
fly apps create spmt-llm-worker --org mtman-new
fly volumes create spmt_llm_models --app spmt-llm-worker --region ord --size 10
fly secrets set --app spmt-llm-worker LLAMA_API_KEY='use-a-long-random-service-token'
fly deploy --config llm-worker/fly.toml --dockerfile llm-worker/Dockerfile
```

If the app already exists, skip `fly apps create`. If the volume already exists, skip `fly volumes create`.

The first boot can remain in a loading state while llama.cpp downloads the model into `/models`. The Fly health check allows up to ten minutes for this initial load.

## Test

```bash
curl https://spmt-llm-worker.fly.dev/health
```

Authenticated model listing:

```bash
curl https://spmt-llm-worker.fly.dev/v1/models \
  -H 'Authorization: Bearer YOUR_LLM_API_KEY'
```

Authenticated chat:

```bash
curl https://spmt-llm-worker.fly.dev/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_LLM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "spmt-qwen3-4b",
    "messages": [{"role": "user", "content": "Reply with one sentence confirming the local route works."}],
    "max_tokens": 80
  }'
```

## Application integration

Do not put `LLAMA_API_KEY` in a browser, Streamer.bot action, or tenant-visible settings. Store it only in the SPMT AI router or server-side app secret store.

Existing paid provider routes remain unchanged. Applications should call this worker only when the authenticated owner/test preference enables the local route, and should fall back to their current provider when the worker is unavailable.

## Changing models

To test another GGUF model, change `LLAMA_ARG_HF_REPO` and `LLAMA_ARG_ALIAS` in `fly.toml`, then deploy again. Keep models in the same volume or create separate worker apps/volumes when different workloads require independent CPU and memory.
