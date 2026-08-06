# ChatGPT MCP Control

Fly Machine Rotator exposes an optional authenticated Model Context Protocol endpoint at:

```text
https://<rotator-app>.fly.dev/mcp
```

The endpoint is a narrow owner control bridge into the existing Athena Coder workflow. It does not expose a shell, Fly tokens, GitHub tokens, secret values, merge, deployment, or Machine mutation.

## Initial tools

- `list_code_references`: list repositories available to Athena Coder.
- `create_coding_job`: create an isolated Codex workspace and run the repository's configured checks.
- `get_coding_job`: read job status, summary, changed files, and checks.

Creating a coding job changes only its isolated workspace. Publishing a branch or draft pull request remains a separate owner action through the existing Athena Coder UI.

## Required Fly secrets

Generate a long random token and store it only as a Fly secret:

```bash
fly secrets set MCP_CONTROL_TOKEN='<long-random-token>'
```

The same token is configured as the remote MCP server bearer credential in the approved client. Never commit it or include it in a prompt.

The MCP bridge also requires the existing internal `CODEX_WORKER_SECRET`, because it calls Athena Coder through the private loopback dashboard API.

## Origin validation

Requests without an `Origin` header are accepted after bearer authentication. Browser-origin requests are rejected unless the exact origin is configured:

```bash
fly secrets set MCP_ALLOWED_ORIGINS='https://chatgpt.com'
```

Add only exact trusted origins. Do not use `*`.

## Authentication

Use either:

```text
Authorization: Bearer <MCP_CONTROL_TOKEN>
```

or the compatibility header:

```text
x-mcp-control-token: <MCP_CONTROL_TOKEN>
```

Bearer authorization is preferred.

## Safety boundary

The first release intentionally cannot:

- execute arbitrary commands;
- read environment variables or secret values;
- push branches;
- publish pull requests;
- merge changes;
- deploy applications;
- create, stop, restart, or delete Fly Machines.

Those operations must be introduced as separate, narrowly scoped tools with explicit owner approval, immutable audit records, and action tokens bound to the exact repository, commit, Fly app, environment, and expiration.

## Validation

Before merging or deploying:

```bash
npm test
npm run typecheck
npm run build
```

After deployment, verify authentication and tool discovery with an MCP-compatible client. Unauthorized requests must return `401`, unapproved browser origins must return `403`, and `tools/list` must return only the three tools documented above.

## Rollback

Removing the `MCP_CONTROL_TOKEN` Fly secret disables all MCP access without affecting the Rotator dashboard, Machine rotation, log monitoring, MountainView, or existing Athena Coder routes.
