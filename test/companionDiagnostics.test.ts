import { describe, expect, it, vi } from 'vitest';
import { buildCompanionDiagnosticsPayload, deliverCompanionDiagnosticsSnapshot } from '../src/companionDiagnostics.js';

describe('Companion diagnostics delivery', () => {
  it('builds a bounded verbose snapshot and removes secret-bearing fields', () => {
    const payload = buildCompanionDiagnosticsPayload({
      states: { configuredAppCount: 1, apiToken: 'must-not-leak' },
      logs: {
        sampledAt: '2026-08-16T10:00:00.000Z',
        logs: [{ appName: 'streamweaver-new', message: 'failed Authorization: Bearer secret-token-value-123' }],
      },
    });

    expect(payload.mode).toBe('verbose');
    expect(payload.states.apiToken).toBe('[REDACTED]');
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
    expect(JSON.stringify(payload)).not.toContain('secret-token-value-123');
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(380_000);
  });

  it('quantifies flagged GP, SP, and XP from the bounded live log sample independently', () => {
    const payload = buildCompanionDiagnosticsPayload({
      states: {},
      logs: {
        sampledAt: '2026-10-17T18:00:00.000Z',
        logs: [
          { appName: 'chat-tag-new', message: 'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"nebula.checkin.front-seat","currency":"GP","operation":"award","delta":100}' },
          { appName: 'streamweaver-new', message: 'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"streamweaver.ride.front-seat","currency":"SP","operation":"award","delta":100}' },
          { appName: 'spacemountain-live', message: 'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"spmt.xp.ledger.award","currency":"XP","operation":"award","delta":25}' },
          { appName: 'spacemountain-live', message: 'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"spmt.xp.ledger.spend","currency":"XP","operation":"spend","delta":-10}' },
        ],
      },
    });

    expect(payload.currencySweep.byCurrency.GP.netDelta).toBe(100);
    expect(payload.currencySweep.byCurrency.SP.netDelta).toBe(100);
    expect(payload.currencySweep.byCurrency.XP.positiveUnits).toBe(25);
    expect(payload.currencySweep.byCurrency.XP.negativeUnits).toBe(10);
    expect(payload.currencySweep.byCurrency.XP.netDelta).toBe(15);
  });

  it('posts through the tenant-bound SPMT platform key without placing it in the body', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).not.toContain('tenant-platform-key');
      return new Response(JSON.stringify({ accepted: true, snapshotId: 'fly-1', status: 'queued' }), { status: 202 });
    });
    const payload = buildCompanionDiagnosticsPayload({ states: {}, logs: { logs: [] } });
    const result = await deliverCompanionDiagnosticsSnapshot(payload, {
      SPMT_API_KEY: 'tenant-platform-key',
      SPMT_BASE_URL: 'https://spmt.live/',
    }, fetchMock as typeof fetch);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://spmt.live/api/platform/companion/diagnostics');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tenant-platform-key' });
    expect(result.accepted).toBe(true);
  });
});
