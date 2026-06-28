# Fly Machine Rotator

Small external Node.js/TypeScript worker that rotates one active Fly Machine per managed app and continuously monitors Fly logs for unique errors. It is designed for stateful chat bots where duplicate active workers can produce duplicate messages.

The worker never deletes Machines. It starts a stopped standby, waits until that Machine is healthy, and only then stops the previous active Machine. If it finds more than one active Machine, it stops extras and reports the correction.

## Behavior

For each app in `FLY_ROTATOR_APPS`:

1. List Machines with `GET /v1/apps/{app_name}/machines`.
2. Acquire a per-app lock using a Fly Machine lease on the active Machine.
3. Pick the current active Machine from `started`, `starting`, or `running` states.
4. Pick a stopped standby from `stopped`, `suspended`, or `created` states.
5. If no standby exists, create one from the active Machine `config` with `skip_launch: true`.
6. Start the standby with `POST /v1/apps/{app_name}/machines/{machine_id}/start`.
7. Poll `GET /v1/apps/{app_name}/machines/{machine_id}` until the Machine is active and health checks pass.
8. Stop the previous active Machine with `POST /v1/apps/{app_name}/machines/{machine_id}/stop`.
9. Verify exactly one Machine is active. If there are extras, stop extras and report a warning.
10. Send a Discord summary with before/after Machine IDs and states.
11. When deployed with the default `monitor` command, the long-lived machine also auto-runs rotations every 12 hours and retries failed rotations after 1 hour.
12. Rotation status and log-monitor failures are merged into one rolling Discord webhook message with a downloadable 24-hour log attachment.

The worker uses the official Fly Machines REST API documented at:

- https://fly.io/docs/machines/api/machines-resource/
- https://fly.io/docs/machines/flyctl/fly-machine-run/#start-a-machine-on-a-schedule

## Configuration

Required secrets:

- `FLY_API_TOKEN`: token with access to all managed apps.
- `FLY_ROTATOR_APPS`: JSON array or comma-separated app list, for example `["bot-a","bot-b","bot-c","bot-d","bot-e","bot-f","bot-g"]`.

Optional secrets/env:

- `DISCORD_WEBHOOK_URL`: Discord webhook for success and failure reports.
- `DRY_RUN`: set to `true` to report actions without changing Machines.
- `HEALTH_TIMEOUT_MS`: default `300000`.
- `HEALTH_POLL_INTERVAL_MS`: default `5000`.
- `STOP_TIMEOUT_SECONDS`: default `60`.
- `LEASE_TTL_SECONDS`: default `900`.
- `REQUIRE_HEALTH_CHECKS`: default `false`. Set `true` if every bot Machine has Fly health checks configured.
- `API_MIN_INTERVAL_MS`: default `400`, roughly 2.5 requests/sec to stay under Fly's per-action burst guidance.

## Local Usage

```bash
npm install
FLY_API_TOKEN=FlyV1... \
FLY_ROTATOR_APPS='["chat-tag-bot-new","chat-tag-new","discord-stream-hub-new","dsh-clip-worker","hearmeout-main","hmo-dj-worker","streamweaver-new"]' \
npm run dry-run
```

Run tests:

```bash
npm test
npm run typecheck
```

## Deploy On Fly.io

Create the external rotator app:

```bash
fly apps create mtman-machine-rotator --org mtman-new
```

Set secrets:

```bash
fly secrets set \
  FLY_API_TOKEN='FlyV1...' \
  FLY_ROTATOR_APPS='["chat-tag-bot-new","chat-tag-new","discord-stream-hub-new","dsh-clip-worker","hearmeout-main","hmo-dj-worker","streamweaver-new"]' \
  DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
```

Deploy the image:

```bash
fly deploy
```

The default deployment runs `node dist/index.js monitor`, which now keeps the log monitor connected and triggers the one-shot rotator internally every 12 hours. The per-app Machine lease still prevents overlapping rotations if a manual `node dist/index.js run` happens at the same time.

## GitHub Actions Deploy

This repo includes `.github/workflows/fly-deploy.yml`, which deploys automatically on pushes to `main` and also supports manual `workflow_dispatch`.

Required GitHub secret:

- `FLY_API_TOKEN`

The workflow runs:

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `flyctl deploy --remote-only --config fly.toml`

Alternative external cron:

```cron
0 */12 * * * docker run --rm --env-file /etc/fly-machine-rotator.env registry.fly.io/fly-machine-rotator:deployment-01
```

## Minimal `fly.toml`

The included `fly.toml` is intentionally small:

```toml
app = "mtman-machine-rotator"
primary_region = "ord"

[build]
  dockerfile = "Dockerfile"

[env]
  FLY_API_HOSTNAME = "https://api.machines.dev"
  HEALTH_TIMEOUT_MS = "300000"
  HEALTH_POLL_INTERVAL_MS = "5000"
  STOP_TIMEOUT_SECONDS = "60"
  REQUIRE_HEALTH_CHECKS = "false"
  API_MIN_INTERVAL_MS = "400"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 256
```

## Safety Notes

- There is no delete implementation in the client or rotator.
- The old active Machine is not stopped until the new Machine passes health verification.
- Discord reports include success/failure, before/after Machine states, and handoff IDs.
- If health checks are not configured and `REQUIRE_HEALTH_CHECKS=false`, a started Machine is considered healthy. For chat bots, configure Fly health checks and set `REQUIRE_HEALTH_CHECKS=true`.

## MountainView AI

The same deployed rotator app also serves the MountainView AI bridge at:

```text
https://mtman-machine-rotator.fly.dev/mountainview
```

MountainView AI adds a phone/mobile control layer for AiMB/RDGlass-style glasses events and the Spacemountain.live apps:

- StreamWeaver image relay, with no face recognition in MountainView AI.
- Configurable GET/POST API commands for StreamWeaver, DiscordStreamHub, Chat-Tag, and HearMeOut.
- Encrypted per-service token storage.
- AI memory records with tags and timeline/search.
- Command execution logs and media upload records.
- Admin-editable integrations and endpoint templates.
- Live stream controls prepared for future direct glasses media support.
- Flash control research path using the RDGlass test command where available.

Runtime storage follows the workspace config policy:

- Secrets: `MOUNTAINVIEW_OWNER_PASSWORD`, `MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY`, and stored service tokens. Set these as Fly secrets.
- Public runtime config: `/data/mountainview-config.json`, seeded on first boot from built-in Spacemountain defaults.
- App state: `/data/mountainview.db`.
- Local-only debug: temporary `MOUNTAINVIEW_DB_FILE` or `MOUNTAINVIEW_CONFIG_FILE` overrides.

Recommended Fly secrets:

```bash
fly secrets set \
  MOUNTAINVIEW_OWNER_PASSWORD='use-a-long-owner-password' \
  MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY='use-a-long-random-encryption-key'
```

Native iOS/Android app source lives in `mobile/`. It is an Expo app that points at the deployed rotator MountainView API by default.

### Android AiMB/RDGlass Native Bridge

The Android app is set up for an Expo Dev Client / prebuild workflow with a MountainView native bridge. For the current AiMB/RDGlass hardware, the working path is Android-native Bluetooth/BLE, media-button capture, speech recognition, audio output routing, and RDGlass command logging. The Meta DAT dependency path is optional and disabled unless `MOUNTAINVIEW_ENABLE_META_DAT=true`.

Build-time requirements:

- Java/JDK with `JAVA_HOME` set.
- Android SDK / Android Studio.
- No Meta developer account is required for the AiMB/RDGlass testing path.

Android build flow:

```bash
cd mobile
npm install
npm run prebuild:android
npm run android
```

The config plugin always installs the MountainView native module. If `MOUNTAINVIEW_ENABLE_META_DAT=true` is set later, it can also inject the optional DAT Maven dependencies, but that is not needed for the current knockoff-glasses workflow. The current native bridge exposes bridge status, BLE scanning/connection/subscription, media-button capture, Android speech recognition, tones, RDGlass camera/flashlight diagnostics, and media trigger commands.
