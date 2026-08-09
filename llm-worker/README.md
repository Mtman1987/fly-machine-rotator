# SPMT Qwen Worker

This directory deploys the Qwen service that SPMT uses for owner-controlled surfaces such as Athena Coder and StreamWeaver private Discord DMs. It is a CPU-hosted Fly application, not the proposed future GPU host.

The worker uses the official llama.cpp server image and downloads:

- repository: `Qwen/Qwen3-8B-GGUF`
- quantization: `Q4_K_M`
- API model alias: `spmt-qwen3-8b`
- approximate model download: about 5 GB

The downloaded GGUF is cached on the persistent `spmt_llm_models` Fly Volume at `/models`, so ordinary restarts do not download it again.

## Private transport and authentication

The worker listens on port 8080 only inside Fly's encrypted private network. `fly.toml` deliberately has no `[http_service]` or `[[services]]` block, so the llama.cpp service is not published through Fly Proxy.

User and application authentication happens before a request reaches Qwen. The worker itself does not use `LLAMA_API_KEY`, `LLAMA_ARG_API_KEY_FILE`, or a second SPMT model key. Applications in the same Fly organization call:

```text
http://spmt-llm-worker.internal:8080/v1/chat/completions
```

No model credential belongs in a browser, tenant setting, Discord DM, Streamer.bot action, or StreamWeaver `.env` file.

## Current sizing

The current configuration uses:

- Qwen3-8B Q4_K_M
- 8 performance CPUs
- 16 GB RAM
- 10 GB persistent volume
- 32,768 total context tokens
- two parallel request slots
- alias `spmt-qwen3-8b`

The 8B model is the production step up from the previous 4B model. A 14B Q4 model is intentionally not the default on this 16 GB CPU machine because model memory plus KV cache and parallel context would leave much less operating headroom.

## Deployment

The `Deploy SPMT LLM Worker` GitHub workflow:

1. ensures the Fly app and model volume exist;
2. removes obsolete llama.cpp authentication secrets;
3. deploys the private worker;
4. releases obsolete public Fly addresses;
5. checks `/health` from the Rotator app; and
6. sends a real `spmt-qwen3-8b` `/v1/chat/completions` request over Fly private networking.

The real chat smoke test matters because `/health` can pass before first inference has proven the model path is usable.

## Private application test

From another app in the same Fly organization:

```bash
curl http://spmt-llm-worker.internal:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "spmt-qwen3-8b",
    "messages": [{"role": "user", "content": "Reply with exactly OK.\n\n/no_think"}],
    "thinking_budget_tokens": 0,
    "max_tokens": 32,
    "temperature": 0,
    "stream": false
  }'
```

## Changing models later

StreamWeaver reads the worker's OpenAI-compatible `/v1/models` endpoint and can surface the effective model to the signed-in tenant. Larger-model changes still belong in this owner deployment configuration so the worker cannot be pointed at an unavailable model from a browser.
