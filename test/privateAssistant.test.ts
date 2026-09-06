import { describe, it, expect, vi } from 'vitest';
import { callPrivateAssistant, privateMediaPath, withSpmtSession } from '../src/privateAssistant.js';

describe('solo companion transport', () => {
  it('bootstraps without a network call, room, or RTC join', async () => {
    const fetcher = vi.fn();
    expect(await callPrivateAssistant({ action: 'ensure' }, fetcher)).toMatchObject({ transport: 'local', private: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('forwards only private chat input and never a caller-selected tenant or room', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, reply: 'hello' }));
    await callPrivateAssistant({ action: 'utterance', text: 'play squad goals by prof', tenantId: 'other', roomId: 'public' }, fetcher);
    const [service, path, init] = fetcher.mock.calls[0] as any;
    expect(service).toBe('streamweaver');
    expect(path).toBe('/api/mountainview/private-assistant');
    expect(JSON.parse(init.body)).toEqual({ action: 'utterance', text: 'play squad goals by prof', speak: true });
  });

  it('refreshes once for concurrent expired-session segment requests', async () => {
    let token = 'expired';
    const refresh = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 5)); token = 'renewed'; return token; });
    const send = vi.fn(async (value: string) => new Response('', { status: value === 'renewed' ? 200 : 401 }));
    const options = { userId: 'owner', getToken: () => token, refresh, send };
    const responses = await Promise.all([withSpmtSession(options), withSpmtSession(options), withSpmtSession(options)]);
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate a session or replay actions on service outages', async () => {
    const refresh = vi.fn();
    const send = vi.fn(async () => new Response('', { status: 503 }));
    const response = await withSpmtSession({ userId: 'owner', getToken: () => 'valid', refresh, send });
    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('restricts the media proxy to HLS assets and retains the source machine pin', () => {
    expect(privateMediaPath('/api/private-assistant/media/youtube/abcdefghijk/segment_12.ts', new URLSearchParams('machine=abc123')))
      .toBe('/api/watch/youtube/hls/abcdefghijk/segment_12.ts?machine=abc123');
    for (const path of ['/api/admin', '/api/private-assistant/media/youtube/abcdefghijk/../secret', '/api/private-assistant/media/youtube/abcdefghijk/https://evil']) {
      expect(privateMediaPath(path, new URLSearchParams())).toBeNull();
    }
  });
});
