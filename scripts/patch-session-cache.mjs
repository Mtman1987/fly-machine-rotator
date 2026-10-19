import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const mobilePath = basename(process.cwd()) === 'mobile' ? 'App.tsx' : 'mobile/App.tsx';
const cacheKey = 'mountainview_workspace_cache_v1';
const cacheDeclaration = `const workspaceCacheKey = "${cacheKey}";`;

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`session cache patch marker missing: ${label}`);
  return source.replace(from, to);
}

let source;
try {
  source = await readFile(mobilePath, 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log(`skipped optional ${mobilePath} session cache patch`);
    process.exit(0);
  }
  throw error;
}

if (
  source.includes(cacheDeclaration) &&
  source.includes('SecureStore.getItemAsync(workspaceCacheKey)') &&
  source.includes('SecureStore.setItemAsync(workspaceCacheKey, JSON.stringify(nextWorkspace))')
) {
  console.log(`MountainView session cache patch already applied to ${mobilePath}`);
  process.exit(0);
}

if (!source.includes(cacheDeclaration)) {
  source = replaceRequired(
    source,
    'const bleLastDeviceKey = "mountainview_last_ble_device";',
    `const bleLastDeviceKey = "mountainview_last_ble_device";\n${cacheDeclaration}`,
    'workspace cache key',
  );
}

const modernStartupMarker = '      const stored = await SecureStore.getItemAsync("mountainview_token");';
if (source.includes('async function restoreConnection()') && source.includes(modernStartupMarker)) {
  const modernStartup = `      const cachedWorkspace = await SecureStore.getItemAsync(workspaceCacheKey);
      if (cachedWorkspace) {
        try {
          const parsed = JSON.parse(cachedWorkspace);
          if (parsed && typeof parsed === "object" && !cancelled) setWorkspace(parsed);
        } catch {}
      }
${modernStartupMarker}`;
  source = replaceRequired(source, modernStartupMarker, modernStartup, 'secure restoreConnection startup');
} else {
  const oldStartup = `  useEffect(() => {\n    SecureStore.getItemAsync("mountainview_token").then((stored) => {\n      if (stored) {\n        setToken(stored);\n        void load(stored);\n      }\n    });\n  }, []);`;
  const newStartup = `  useEffect(() => {\n    Promise.all([\n      SecureStore.getItemAsync("mountainview_token"),\n      SecureStore.getItemAsync(workspaceCacheKey),\n    ]).then(([stored, cachedWorkspace]) => {\n      if (cachedWorkspace) {\n        try {\n          const parsed = JSON.parse(cachedWorkspace);\n          if (parsed && typeof parsed === "object") setWorkspace(parsed);\n        } catch {}\n      }\n      if (stored) {\n        setToken(stored);\n        void load(stored).catch((error) => {\n          reportSoftError("MountainView background sync", error);\n        });\n      }\n    }).catch(() => {});\n  }, []);`;
  source = replaceRequired(source, oldStartup, newStartup, 'secure startup restore');
}

const oldLoad = `    const data = await request("/bootstrap", {}, authToken);\n    setWorkspace(data.workspace ?? null);\n    setCommands(data.commands ?? []);`;
const newLoad = `    const data = await request("/bootstrap", {}, authToken);\n    const nextWorkspace = data.workspace ?? null;\n    setWorkspace(nextWorkspace);\n    if (nextWorkspace) {\n      void SecureStore.setItemAsync(workspaceCacheKey, JSON.stringify(nextWorkspace)).catch(() => {});\n    } else {\n      void SecureStore.deleteItemAsync(workspaceCacheKey).catch(() => {});\n    }\n    setCommands(data.commands ?? []);`;
source = replaceRequired(source, oldLoad, newLoad, 'background bootstrap cache');

await writeFile(mobilePath, source);
console.log(`patched ${mobilePath} with cache-first MountainView workspace bootstrap`);
