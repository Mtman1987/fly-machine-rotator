import { getFlyObservabilitySnapshot } from './flyObservability.js';
import { redactSensitiveText } from './redaction.js';

export type CompanionDiagnosticsPayload = {
  snapshotId: string;
  capturedAt: string;
  mode: 'debug' | 'verbose';
  states: Record<string, unknown>;
  logs: Array<Record<string, unknown>>;
};

const SECRET_KEY = /(?:authorization|password|secret|token|api[_-]?key|cookie)/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, 8_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(-500).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 500).map(([key, item]) => [
      key.slice(0, 120),
      SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1),
    ]));
  }
  return redactSensitiveText(value);
}

export function buildCompanionDiagnosticsPayload(
  snapshot: { states?: unknown; logs?: { logs?: unknown[]; sampledAt?: string } },
  mode: 'debug' | 'verbose' = 'verbose',
): CompanionDiagnosticsPayload {
  const capturedAt = new Date(snapshot.logs?.sampledAt || Date.now()).toISOString();
  const payload: CompanionDiagnosticsPayload = {
    snapshotId: `fly-${capturedAt.replace(/[:.]/g, '-')}`,
    capturedAt,
    mode,
    states: sanitizeValue(snapshot.states || {}) as Record<string, unknown>,
    logs: (Array.isArray(snapshot.logs?.logs) ? snapshot.logs.logs : [])
      .slice(-500)
      .map((entry) => sanitizeValue(entry) as Record<string, unknown>),
  };

  while (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 380_000 && payload.logs.length > 1) {
    payload.logs = payload.logs.slice(Math.ceil(payload.logs.length / 4));
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 380_000) {
    throw new Error('Sanitized Companion diagnostics snapshot exceeds the relay limit.');
  }
  return payload;
}

export async function deliverCompanionDiagnosticsSnapshot(
  payload: CompanionDiagnosticsPayload,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  const token = String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || '').trim();
  if (!token) throw new Error('SPMT_API_KEY or SPMT_PLATFORM_API_KEY is required for Companion diagnostics delivery.');
  const baseUrl = String(env.SPMT_BASE_URL || 'https://spmt.live').replace(/\/$/, '');
  const response = await fetchImpl(`${baseUrl}/api/platform/companion/diagnostics`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-spacemountain-source': 'fly-machine-rotator',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`SPMT Companion diagnostics delivery failed (${response.status}): ${redactSensitiveText(result.error || response.statusText).slice(0, 500)}`);
  }
  return result;
}

export async function publishCompanionDiagnosticsSnapshot(env: NodeJS.ProcessEnv = process.env) {
  const limit = Math.min(500, Math.max(1, Number(env.COMPANION_DIAGNOSTICS_LOG_LIMIT || 200)));
  const durationMs = Math.min(10_000, Math.max(500, Number(env.COMPANION_DIAGNOSTICS_SAMPLE_MS || 5_000)));
  const snapshot = await getFlyObservabilitySnapshot({ limit, durationMs, errorsOnly: false }, env);
  const payload = buildCompanionDiagnosticsPayload(snapshot, env.COMPANION_DIAGNOSTICS_MODE === 'debug' ? 'debug' : 'verbose');
  return deliverCompanionDiagnosticsSnapshot(payload, env);
}

export async function runCompanionDiagnosticsLoop(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (String(env.ROTATOR_COMPANION_DIAGNOSTICS_ENABLED || 'true').toLowerCase() === 'false') return;
  if (!String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || '').trim()) {
    console.warn('Companion diagnostics delivery is disabled because no tenant-bound SPMT platform key is configured.');
    return;
  }
  const intervalMs = Math.max(60_000, Number(env.COMPANION_DIAGNOSTICS_INTERVAL_MS || 5 * 60_000));
  for (;;) {
    try {
      const result = await publishCompanionDiagnosticsSnapshot(env);
      console.log(`queued sanitized Companion diagnostics snapshot ${String(result.snapshotId || '')}`);
    } catch (error) {
      console.warn(redactSensitiveText(error instanceof Error ? error.message : String(error)));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
