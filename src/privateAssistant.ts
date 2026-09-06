import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type Json = Record<string, unknown>;
type AuthFetch = (service: 'streamweaver' | 'hearmeout', path: string, init?: RequestInit) => Promise<Response>;
const refreshes = new Map<string, Promise<string>>();

export async function withSpmtSession(input: {
  userId: string; getToken: () => string; refresh: () => Promise<string>;
  send: (token: string) => Promise<Response>;
}): Promise<Response> {
  const original = input.getToken();
  let response = await input.send(original);
  if (response.status !== 401) return response;
  await response.body?.cancel();
  // Several HLS segment requests may discover an expired token together.
  let refreshed = refreshes.get(input.userId);
  if (!refreshed) {
    refreshed = input.getToken() !== original
      ? Promise.resolve(input.getToken()) : input.refresh();
    refreshes.set(input.userId, refreshed);
  }
  try { response = await input.send(await refreshed); }
  finally { if (refreshes.get(input.userId) === refreshed) refreshes.delete(input.userId); }
  return response;
}

export async function callPrivateAssistant(input: Json, fetcher: AuthFetch): Promise<Json> {
  if (input.action === 'ensure') return { ok: true, private: true, transport: 'local', status: 'ready' };
  const response = await fetcher('streamweaver', '/api/mountainview/private-assistant', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: input.action || 'utterance', text: input.text || input.command || input.transcript,
      speak: input.speak !== false, requestId: input.requestId, currentRequestId: input.currentRequestId,
    }), signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => ({ error: 'Private assistant returned an invalid response' })) as Json;
  return { ...payload, upstreamStatus: response.status };
}

export function privateMediaPath(pathname: string, search: URLSearchParams): string | null {
  const offline = pathname.match(/\/private-assistant\/media\/offline\/([A-Za-z0-9_-]{1,1024})$/);
  if (offline) return `/api/offline-music?id=${encodeURIComponent(offline[1])}`;
  const match = pathname.match(/\/private-assistant\/media\/youtube\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_-]+\.(?:m3u8|ts|m4s|mp4|webm))$/);
  if (!match) return null;
  const machine = search.get('machine');
  if (machine && !/^[a-zA-Z0-9]{1,64}$/.test(machine)) return null;
  return `/api/watch/youtube/hls/${match[1]}/${match[2]}` + (machine ? `?machine=${machine}` : '');
}

export async function proxyPrivateMedia(request: IncomingMessage, response: ServerResponse, url: URL, fetcher: AuthFetch) {
  const path = privateMediaPath(url.pathname, url.searchParams);
  if (!path) { response.writeHead(400).end('Invalid media path'); return; }
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  response.once('close', disconnect);
  try {
    const upstream = await fetcher('hearmeout', path, {
      headers: request.headers.range ? { range: request.headers.range } : {},
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]),
    });
    const headers: Record<string, string> = { 'cache-control': 'private, no-store' };
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'retry-after']) {
      const value = upstream.headers.get(key);
      if (value) headers[key] = value;
    }
    response.writeHead(upstream.status, headers);
    // Relative HLS segment references retain this proxy and the worker pin.
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), response);
    else response.end();
  } catch (error) {
    if (!abort.signal.aborted && !response.headersSent) response.writeHead(502).end('Media source unavailable');
    else if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
  } finally { response.off('close', disconnect); }
}
