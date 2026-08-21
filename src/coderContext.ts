import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 384 * 1024;
const MAX_MAP_CHARS = 28_000;
const MAX_CONTEXT_CHARS = 86_000;
const MAX_FILE_CHARS = 14_000;

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".yml", ".yaml", ".toml", ".css", ".scss", ".html", ".sql", ".sh",
  ".py", ".go", ".rs", ".java", ".kt", ".swift", ".cs", ".xml", ".graphql",
]);

const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.|$)|secrets?(?:\.|\/|$)|credentials?(?:\.|\/|$)|private[-_]?keys?(?:\.|\/|$)|id_rsa|id_ed25519)|\.(?:pem|p12|pfx|key)$/i;
const GENERATED_PATH = /(^|\/)(?:node_modules|\.next|dist|build|coverage|vendor|target)(\/|$)/i;
const STOP_WORDS = new Set([
  "with", "that", "this", "from", "only", "current", "default", "without", "when", "then",
  "into", "have", "does", "should", "could", "would", "there", "their", "about", "after", "before",
  "error", "issue", "fix", "broken", "please", "athena", "coder", "repair",
]);

function termsFor(description: string): string[] {
  return [...new Set(description.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 40);
}

function isReadableSource(path: string): boolean {
  if (!path || SENSITIVE_PATH.test(path) || GENERATED_PATH.test(path)) return false;
  const base = path.split("/").pop() || "";
  if (/^(?:Dockerfile|Makefile|Procfile|AGENTS\.md|README(?:\.[^.]+)?|package\.json|tsconfig(?:\.[^.]+)?\.json|fly\.toml)$/i.test(base)) return true;
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function pathScore(path: string, terms: string[]): number {
  const lower = path.toLowerCase();
  let score = terms.reduce((total, term) => total + (lower.includes(term) ? 7 : 0), 0);
  if (/AGENTS\.md$|README|package\.json$|tsconfig|fly\.toml$|Dockerfile$/i.test(path)) score += 18;
  if (/(^|\/)(src|app|server|lib|services|routes|api|test|tests|scripts)(\/|$)/i.test(path)) score += 3;
  if (/\.test\.|\.spec\.|(^|\/)tests?\//i.test(path)) score += 2;
  return score;
}

function contentScore(source: string, terms: string[]): number {
  const lower = source.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const first = lower.indexOf(term);
    if (first < 0) continue;
    score += 4;
    const second = lower.indexOf(term, first + term.length);
    if (second >= 0) score += 2;
  }
  return score;
}

async function safeRead(workspace: string, path: string): Promise<string> {
  try {
    const full = join(workspace, path);
    const info = await stat(full);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return "";
    const source = await readFile(full, "utf8");
    return source.includes("\u0000") ? "" : source;
  } catch {
    return "";
  }
}

function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) found.add(match[1]);
    }
  }
  return [...found];
}

async function resolveRelativeImport(workspace: string, fromPath: string, specifier: string): Promise<string | null> {
  const base = normalize(join(dirname(fromPath), specifier)).replaceAll("\\", "/");
  if (base.startsWith("../") || base === "..") return null;
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`,
  ];
  for (const candidate of candidates) {
    try {
      await access(resolve(workspace, candidate));
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function buildRepositoryContext(description: string, workspace: string): Promise<string> {
  const tracked = (await execFileAsync("git", ["ls-files"], { cwd: workspace, timeout: 60_000 })).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const readable = tracked.filter(isReadableSource);
  const terms = termsFor(description);

  const scored: Array<{ path: string; source: string; score: number }> = [];
  const concurrency = 24;
  for (let offset = 0; offset < readable.length; offset += concurrency) {
    const batch = readable.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (path) => {
      const initial = pathScore(path, terms);
      const source = await safeRead(workspace, path);
      if (!source) return null;
      return { path, source, score: initial + contentScore(source, terms) };
    }));
    scored.push(...results.filter((item): item is { path: string; source: string; score: number } => Boolean(item)));
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const selected = new Map<string, string>();
  for (const item of scored.slice(0, 20)) selected.set(item.path, item.source);

  for (const [path, source] of [...selected.entries()].slice(0, 12)) {
    for (const specifier of importSpecifiers(source)) {
      const neighbor = await resolveRelativeImport(workspace, path, specifier);
      if (!neighbor || selected.has(neighbor) || !isReadableSource(neighbor)) continue;
      const neighborSource = await safeRead(workspace, neighbor);
      if (neighborSource) selected.set(neighbor, neighborSource);
      if (selected.size >= 30) break;
    }
    if (selected.size >= 30) break;
  }

  const selectedNames = [...selected.keys()];
  for (const item of scored) {
    if (selected.size >= 34) break;
    if (!/\.test\.|\.spec\.|(^|\/)tests?\//i.test(item.path)) continue;
    const lower = item.path.toLowerCase();
    const related = selectedNames.some((path) => {
      const stem = (path.split("/").pop() || "").replace(/\.[^.]+$/, "").toLowerCase();
      return stem.length > 3 && lower.includes(stem);
    });
    if (related) selected.set(item.path, item.source);
  }

  const mapHeader = readable.slice().sort().join("\n");
  const map = mapHeader.length > MAX_MAP_CHARS
    ? `${mapHeader.slice(0, MAX_MAP_CHARS)}\n... repository map truncated (${readable.length} readable tracked files total)`
    : mapHeader;

  let context = `Repository inventory: ${tracked.length} tracked files; ${readable.length} readable source/config/test files.\n`;
  context += `Problem terms: ${terms.join(", ") || "none extracted"}\n\n`;
  context += `--- REPOSITORY FILE MAP ---\n${map}\n`;
  context += `\n--- HIGH-RELEVANCE FILE CONTENT ---`;

  for (const [path, source] of selected) {
    if (context.length >= MAX_CONTEXT_CHARS) break;
    const remaining = MAX_CONTEXT_CHARS - context.length;
    const excerpt = source.slice(0, Math.min(MAX_FILE_CHARS, Math.max(0, remaining - path.length - 32)));
    if (!excerpt) break;
    context += `\n\n--- ${path} ---\n${excerpt}`;
  }

  if (!selected.size) throw new Error("Athena Coder could not select readable repository context.");
  return context;
}
