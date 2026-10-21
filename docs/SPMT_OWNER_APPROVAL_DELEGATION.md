# SPMT owner-approved scoped log grants

Rotator's `/logs/errors.txt` flow can request owner approval when no authenticated SPMT admin session is present. It accepts only a single-use `logs:read:last24h` grant; no action-token bypass is added.

## Required Fly secrets

- `SPMT_OWNER_APPROVAL_SERVICE_SECRET`: at least 32 random characters, same value on SPMT and Rotator.
- `SPMT_DELEGATION_SIGNING_SECRET`: at least 32 random characters, same value on SPMT and Rotator.
- `SPMT_OWNER_APPROVAL_CALLBACK_SECRET`: at least 32 random characters, same value on SPMT and Rotator.
- `SPMT_BASE_URL=https://spmt.live` on Rotator.
- `ROTATOR_PUBLIC_BASE_URL=https://mtman-machine-rotator.fly.dev` on SPMT.

Do not reuse OAuth credentials, `ROTATOR_DASHBOARD_ACTION_TOKEN`, GitHub tokens, or user cookies. Do not print secret values during configuration or validation.

Rotator validates the HS256 signature, issuer, audience, exact scope, expiry, and one-time JTI. Consumed grant IDs are persisted under the configured evidence directory. Pending grants are private server-side files with mode 0600, and a grant is only selected by its exact approval request ID.

## Validation

Use the SPMT UI at `/owner-approvals.html`. Sign out of Rotator, request `/logs/errors.txt`, approve the generated request in SPMT, and follow the retrieval link. Verify the same request ID cannot be consumed twice. If any secret is absent or mismatched, the flow must fail closed.