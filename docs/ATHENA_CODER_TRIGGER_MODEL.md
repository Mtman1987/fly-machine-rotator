# Athena Coder Trigger Model

Athena Coder repair and Fly Machine rotation are intentionally independent systems.

## Repair path

A new actionable error detected by the live Fly log monitor should trigger the Coder promptly, without waiting for the next scheduled machine rotation.

Target flow:

`new actionable error -> classify/dedupe -> Athena Coder -> local Qwen first -> isolated repair branch/worktree -> checks -> review/promotion -> post-fix verification`

Repeated fingerprints should be deduplicated so one persistent failure does not start overlapping repair jobs.

## Rotation path

Machine rotation remains a separate maintenance process. It rotates/restarts managed Fly Machines on its own schedule and may also be invoked manually for testing.

Rotation must not be the normal trigger for code repair. Otherwise errors can remain broken for hours and accumulate before an arbitrary maintenance window.

## Manual repair path

`!mtfixit` should invoke the same repair engine immediately for manual testing without waiting for either the error monitor or the rotation schedule.

## Provider behavior

The Athena Coder tries the private SPMT local LLM first when `SPMT_LLM_BASE_URL` is configured. Paid providers are fallbacks only when the private provider cannot produce a usable repair plan.
