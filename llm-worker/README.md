# SPMT Qwen Worker

This directory deploys the Qwen service that SPMT already uses today. It is a CPU-hosted Fly application, not the proposed future GPU host, and it is shared by owner-controlled SPMT surfaces such as Athena Coder and StreamWeaver private Discord DMs.

The worker uses the official llama.cpp server image and downloads:

- repository: `Qwen/Qwen3-4B-GGUF`
- quantization: `Q4_K_M`
- API model alias: `spmt-qwen3-4b`
- approximate model download: 2.5 GB

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

- 8 performance CPUs
- 16 GB RAM
- 10 GB persistent volume
- 32,768 total context tokens
- two parallel request slots
- alias `spmt-qwen3-4b`

## Deployment

The `Deploy SPMT LLM Worker` GitHub workflow:

1. ensures the Fly app and model volume exist;
2. removes obsolete llama.cpp authentication secrets;
3. deploys the private worker;
4. releases obsolete public Fly addresses;
5. checks `/health` from the Rotator app; and
6. sends a real keyless `/v1/chat/completions` request over Fly private networking.

The real chat smoke test matters because `/health` can still pass when a stale llama.cpp API-key setting blocks generation.

## Private application test

From another app in the same Fly organization:

```bash
curl http://spmt-llm-worker.internal:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "spmt-qwen3-4b",
    "messages": [{"role": "user", "content": "Reply with exactly OK.\n\n/no_think"}],
    "thinking_budget_tokens": 0,
    "max_tokens": 32,
    "temperature": 0,
    "stream": false
  }'
```

## Changing models later

A future GPU service can replace the internal implementation without adding tenant configuration. Until then, Adult Mode and Athena Coder use this existing `spmt-qwen3-4b` worker. Model changes belong in the owner deployment configuration, not in user-facing settings.
