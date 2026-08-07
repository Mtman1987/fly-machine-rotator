import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type SpmtIdentity = Record<string, unknown> & {
  id?: string;
  username?: string;
  isAdmin?: boolean;
  is_admin?: boolean | number;
  role?: string;
  roles?: string[];
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
};

const ROTATOR_ACCESS_COOKIE = "rotator_spmt_access_token";
const ROTATOR_REFRESH_COOKIE = "rotator_spmt_refresh_token";
const ROTATOR_STATE_COOKIE = "rotator_spmt_oauth_state";
const ROTATOR_NEXT_COOKIE = "rotator_spmt_oauth_next";

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(String(header || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function appendSetCookie(response: ServerResponse, value: string) {
  const existing = response.getHeader("set-cookie");
  const items = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  response.setHeader("set-cookie", [...items, value]);
}

function cookieSecure(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || String(env.ROTATOR_PUBLIC_BASE_URL || env.MOUNTAINVIEW_BASE_URL || "https://mtman-machine-rotator.fly.dev").startsWith("https://");
}

function setCookie(response: ServerResponse, name: string, value: string, maxAge: number, env: NodeJS.ProcessEnv) {
  appendSetCookie(response, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${cookieSecure(env) ? "; Secure" : ""}`);
}

function clearCookie(response: ServerResponse, name: string, env: NodeJS.ProcessEnv) {
  setCookie(response, name, "", 0, env);
}

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeNext(value: string | null | undefined): string {
  const next = String(value || "/").trim();
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/mountainview/auth/callback")) return "/";
  return next.slice(0, 500);
}

function rotatorCallbackUrl(env: NodeJS.ProcessEnv): string {
  const base = String(env.ROTATOR_PUBLIC_BASE_URL || env.MOUNTAINVIEW_BASE_URL || "https://mtman-machine-rotator.fly.dev").replace(/\/$/, "");
  return `${base}/mountainview/auth/callback`;
}

function redirect(response: ServerResponse, location: string): true {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
  return true;
}

function sendJson(response: ServerResponse, status: number, value: unknown): true {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
  return true;
}

export async function handleRotatorSpmtAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/auth/spmt/login") {
    const state = randomBytes(32).toString("base64url");
    const next = safeNext(url.searchParams.get("next"));
    setCookie(response, ROTATOR_STATE_COOKIE, state, 10 * 60, env);
    setCookie(response, ROTATOR_NEXT_COOKIE, next, 10 * 60, env);

    const baseUrl = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
    const authorize = new URL("/api/oauth/authorize", baseUrl);
    authorize.searchParams.set("client_id", String(env.ROTATOR_SPMT_CLIENT_ID || "mountainview"));
    authorize.searchParams.set("redirect_uri", rotatorCallbackUrl(env));
    authorize.searchParams.set("state", state);
    return redirect(response, authorize.toString());
  }

  if (request.method === "GET" && url.pathname === "/auth/spmt/logout") {
    clearCookie(response, ROTATOR_ACCESS_COOKIE, env);
    clearCookie(response, ROTATOR_REFRESH_COOKIE, env);
    clearCookie(response, ROTATOR_STATE_COOKIE, env);
    clearCookie(response, ROTATOR_NEXT_COOKIE, env);
    return redirect(response, "/auth/spmt/login?next=%2F");
  }

  if (request.method !== "GET" || url.pathname !== "/mountainview/auth/callback") return false;

  const cookies = parseCookies(request.headers.cookie);
  const rotatorState = cookies[ROTATOR_STATE_COOKIE] || "";
  const mountainViewState = cookies.mountainview_oauth_state || "";
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";

  if (!rotatorState) {
    if (mountainViewState) return false;
    if (state || code) return redirect(response, "/auth/spmt/login?next=%2F");
    return false;
  }

  const next = safeNext(cookies[ROTATOR_NEXT_COOKIE]);
  if (!code || !safeEqual(state, rotatorState)) {
    clearCookie(response, ROTATOR_STATE_COOKIE, env);
    clearCookie(response, ROTATOR_NEXT_COOKIE, env);
    return redirect(response, `/auth/spmt/login?next=${encodeURIComponent(next)}`);
  }

  const clientSecret = String(env.ROTATOR_SPMT_CLIENT_SECRET || env.MOUNTAINVIEW_CLIENT_SECRET || "").trim();
  if (!clientSecret) return sendJson(response, 503, { error: "Rotator SPMT OAuth is not configured" });

  const baseUrl = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
  const tokenResponse = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: String(env.ROTATOR_SPMT_CLIENT_ID || "mountainview"),
      client_secret: clientSecret,
      redirect_uri: rotatorCallbackUrl(env),
    }),
  }).catch(() => null);

  if (!tokenResponse?.ok) {
    clearCookie(response, ROTATOR_STATE_COOKIE, env);
    clearCookie(response, ROTATOR_NEXT_COOKIE, env);
    return sendJson(response, 502, { error: "SPMT sign-in exchange failed. Start a fresh Rotator sign-in." });
  }

  const tokens = await tokenResponse.json().catch(() => null) as OAuthTokenResponse | null;
  if (!tokens?.access_token) return sendJson(response, 502, { error: "SPMT sign-in response did not include an access token" });

  setCookie(response, ROTATOR_ACCESS_COOKIE, tokens.access_token, Number(tokens.expires_in || 7 * 24 * 60 * 60), env);
  if (tokens.refresh_token) setCookie(response, ROTATOR_REFRESH_COOKIE, tokens.refresh_token, Number(tokens.refresh_expires_in || 30 * 24 * 60 * 60), env);
  clearCookie(response, ROTATOR_STATE_COOKIE, env);
  clearCookie(response, ROTATOR_NEXT_COOKIE, env);
  return redirect(response, next);
}

export function readSpmtAccessToken(request: IncomingMessage): string {
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const cookies = parseCookies(request.headers.cookie);
  return bearer || cookies[ROTATOR_ACCESS_COOKIE] || cookies.spmt_access_token || cookies["streamweaver-spmt-token"] || cookies.spmt_token || "";
}

export function isSpmtAdmin(identity: SpmtIdentity | null | undefined): boolean {
  if (!identity) return false;
  if (identity.isAdmin === true || identity.is_admin === true || identity.is_admin === 1) return true;
  const role = String(identity.role || "").toLowerCase();
  if (role === "admin" || role === "owner") return true;
  const roles = Array.isArray(identity.roles) ? identity.roles.map((value) => String(value).toLowerCase()) : [];
  return roles.includes("admin") || roles.includes("owner");
}

export async function requireSpmtIdentity(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<SpmtIdentity | null> {
  const token = readSpmtAccessToken(request);
  if (!token) return null;
  const baseUrl = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/oauth/userinfo`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json().catch(() => null) as any;
  const identity = (payload?.user || payload?.profile || payload) as SpmtIdentity | null;
  return identity?.id ? identity : null;
}

export async function requireSpmtAdmin(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<SpmtIdentity | null> {
  const identity = await requireSpmtIdentity(request, env);
  return identity && isSpmtAdmin(identity) ? identity : null;
}
