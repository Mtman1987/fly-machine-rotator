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
