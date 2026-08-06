import type { IncomingMessage } from "node:http";

export type SpmtIdentity = Record<string, unknown> & {
  id?: string;
  username?: string;
  isAdmin?: boolean;
  is_admin?: boolean | number;
  role?: string;
  roles?: string[];
};

function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(String(header || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function readSpmtAccessToken(request: IncomingMessage): string {
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const cookies = parseCookies(request.headers.cookie);
  return bearer || cookies.spmt_access_token || cookies["streamweaver-spmt-token"] || cookies.spmt_token || "";
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
