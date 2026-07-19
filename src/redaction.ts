const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const QUERY_SECRET_PATTERN = /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|signature|jwt)=)[^&\s"'<>]+/gi;
const BEARER_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const HEADER_SECRET_PATTERN = /(\b(?:authorization|x-api-key|api-key)\s*[:=]\s*)([^\s,;}\]]{8,})/gi;
const JSON_SECRET_PATTERN = /(["']?(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|authorization)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi;

export function redactSensitiveText(value: unknown): string {
  return String(value ?? "")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]")
    .replace(HEADER_SECRET_PATTERN, "$1[REDACTED]")
    .replace(JSON_SECRET_PATTERN, "$1[REDACTED]$3")
    .replace(JWT_PATTERN, "[REDACTED_JWT]");
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactSensitiveValue(item)])
    ) as T;
  }
  return value;
}
