# Currency Sweeper — rough draft (read-only)

The first pass preserves three separate currencies: GP (Nebula), SP (StreamWeaver), and XP (SPMT support/catch-all). The Rotator Companion diagnostics payload now includes a `currencySweep` summary derived from the same bounded log sample already collected by the existing observability pipeline. It parses only explicit `CURRENCY_SWEEP_V1` log markers; it does not merge wallets, mutate balances, set prices, or trigger purchases. Known source IDs must match their registered currency, and operations must use the supported operation vocabulary.

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

The parser is integrated into the Rotator Companion snapshot builder, but production delivery and real flagged events have not been verified in this draft. It only quantifies the bounded log window; it will undercount unflagged paths and log samples that omit older entries. Next steps: confirm the current production release path, observe a real snapshot with flags, instrument remaining mutation paths, and compare deltas against authoritative ledger/state snapshots. Keep all collection read-only.
