# Currency Sweeper — rough draft (read-only)

The first pass preserves three separate currencies: GP (Nebula), SP (StreamWeaver), and XP (SPMT support/catch-all). It parses only explicit `CURRENCY_SWEEP_V1` log markers; it does not merge wallets, mutate balances, set prices, or trigger purchases.

## Current known source registry

| Currency | Source ID | Code location | Draft state |
|---|---|---|---|
| GP | `nebula.checkin.front-seat` | ChatTag `src/lib/checkin-nebula-bonus.ts` and check-in award route | Flag added in draft branch |
| SP | `streamweaver.ride.front-seat` | ApolloStation `apps/streamweaver/src/ride-runtime.ts` | Flag added in draft branch |
| XP | `spmt.xp.ledger.award` | SPMT `POST /api/platform/xp` | Flag added in draft branch |
| XP | `spmt.xp.ledger.spend` | SPMT `POST /api/platform/xp/spend` | Flag added in draft branch |
| XP | `spmt.xp.ledger.transfer` | SPMT `POST /api/platform/xp/transfer` | Flag added in draft branch |
| XP | `spmt.xp.ledger.gamble` | SPMT `POST /api/platform/xp/gamble-settle` | Flag added in draft branch |
| XP | `spmt.xp.ledger.migration` | SPMT `POST /api/platform/xp/migrate-balance` | Flag added in draft branch |

## How to quantify

Import `scanCurrencySweepLogsV1` and supply the bounded Rotator log sample as lines. The report separates positive units, negative units, net delta, duplicate events, malformed markers, and unknown source IDs by currency and source. Duplicates are not counted.

## Important limits

This is a parser prototype, not yet a live Rotator collector or a source-of-truth supply report. It only quantifies the supplied log window. It will undercount unflagged paths and log samples that omit older entries. Next step after review: wire the parser to the existing bounded Rotator log sampler, flag the remaining XP mutation paths, and compare log deltas against authoritative ledger/state snapshots. Keep all collection read-only.
