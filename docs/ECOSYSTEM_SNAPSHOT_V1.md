# Ecosystem Snapshot v1

`spmt.ecosystem-state/v1` is the first machine-readable public contract for the current SpaceMountain ecosystem.

## Producer

MTMan Machine Rotator is the collector. It combines stable repository/product declarations with sanitized Fly Machine observations already available through the Rotator observability layer.

Public endpoint:

```text
GET /ecosystem/v1/public.json
```

The public response is intentionally smaller than Rotator's internal observability data. It never includes Machine configuration, private IPs, environment variables, tokens, secret values, raw logs, health-check output, or Machine IDs.

## Authority model

The contract keeps authored facts separate from observed runtime facts.

- `lifecycle`, repository identity, product URLs, interface flags, service roles, and stable product IDs are declared facts.
- `runtime.status`, Machine counts, aggregate Machine states, failing-check counts, and observation timestamps are observed facts.
- A runtime outage must not change an application's declared lifecycle or erase its documented capability.

## Stable IDs

Stable product IDs are independent of Fly application names. For example, `discord-stream-hub` remains the product ID even if a Fly service is later renamed.

A product may have more than one service. The current repository map is used to associate those services with the stable product record.

## Consumer rules

Consumers must require `schemaVersion === "spmt.ecosystem-state/v1"`.

Documentation templates may resolve scalar paths such as:

```text
{{apps.spmt.urls.public}}
{{apps.streamweaver.repository.name}}
{{apps.streamweaver.services.streamweaver-new.runtime.status}}
```

A missing template value is an error. Consumers must not silently render an empty string, `undefined`, or a stale substitute.

## Evolution

Breaking structural changes require a new contract version and endpoint. Additive fields may be introduced within v1 only when existing v1 consumers remain valid.

JSON Schema: `docs/contracts/spmt.ecosystem-state.v1.schema.json`.
