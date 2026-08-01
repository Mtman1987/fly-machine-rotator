---
name: testing-mountainview-voice-routing
description: How to boot the MountainView dashboard server locally and test voice/command routing decisions (POST /mountainview/api/voice/route), including before/after comparison against a baseline branch.
---

# Testing MountainView voice/command routing

## Boot a local server (no auth, temp state)
`startDashboardServer` is exported from `src/dashboardServer.ts` and takes an env object, so
you can boot it from a small ESM script run with `npx tsx` (repo is `"type": "module"`; import the
`.js` specifier and tsx resolves the `.ts`):

```js
import { startDashboardServer } from "/abs/path/repo/src/dashboardServer.js";
startDashboardServer({
  NODE_ENV: "test", PORT: "8099",
  MOUNTAINVIEW_DB_FILE: "/tmp/mv/mountainview.db",
  MOUNTAINVIEW_CONFIG_FILE: "/tmp/mv/mountainview-config.json",
  MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY: "test-encryption-key",
  MOUNTAINVIEW_AUTH_DISABLED: "true",
});
```
Run it detached: `(npx tsx boot.mjs > /tmp/mv/server.log 2>&1 &)` and wait ~6s for
`dashboard listening on <port>`. `PORT: "0"` also works if you read `server.address()`.

## Exercise the router
```
POST http://127.0.0.1:<port>/mountainview/api/voice/route
{"transcript":"...", "dryRun":true,
 "context":{"routeMode":"chat","tenantId":"94371378","username":"mtman1987"}}
```
Read `decision.appId`, `decision.commandId`, `decision.mode`,
`decision.payload.destination`, `decision.payload.bridgeToDiscord`, and `decision.transcript`
(the extracted message body). Always keep `dryRun: true` — non-dryRun attempts real dispatch to
Discord/Twitch/HearMeOut backends.

## Before/after comparison (strongest evidence)
Routing changes look identical to a broken build unless you diff against the base branch. Create a
worktree of the base commit, symlink the already-installed deps, and boot a second server on
another port:
```
git worktree add /tmp/base-main main
ln -s /abs/path/repo/node_modules /tmp/base-main/node_modules
# boot with the same env but PORT 8098 and different DB/CONFIG files
```
Then run the same transcript matrix against both ports and render the pairs into a small HTML table
served with `python3 -m http.server` for screenshots. **Gotcha:** parameterize the base URL in the
matrix script (`process.env.BASE`) — a hard-coded port silently makes "baseline" results identical
to the branch results.

## Known behaviours / gotchas
- There is **no UI** in the MountainView dashboard (`GET /mountainview`) that submits a transcript to
  the voice router, so this feature is API-only; visual evidence must be a rendering of live JSON.
- `test/unifiedReport.test.ts` may fail on the box with a locale issue rendering midnight as `24:31`
  instead of `00:31`. Verify against the base branch before blaming a PR — it has been pre-existing.
- Message-extraction edge cases worth re-checking after any regex change: trailing punctuation is
  kept in the body; "post to the discord server: X" can leak the word `server:` into the body; a
  content-less "send a discord message" uses the whole transcript as the body.

## Devin Secrets Needed
- None for local routing tests. `FLY_API_TOKEN` would only be needed for deploys and has been
  rejected ("root banned"); `https://discord-stream-hub-new.fly.dev` has been unreachable, so live
  dispatch may not be testable — stay on dryRun/local.
