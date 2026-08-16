import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename } from 'node:path';

const mobilePath = basename(process.cwd()) === 'mobile' ? 'App.tsx' : 'mobile/App.tsx';
try {
  await access(mobilePath, constants.R_OK | constants.W_OK);
} catch {
  console.log(`skipped optional ${mobilePath} native presence patch`);
  process.exit(0);
}

let source = await readFile(mobilePath, 'utf8');
if (source.includes('mountainview_presence_client_v1')) {
  console.log(`MountainView native presence patch already applied to ${mobilePath}`);
  process.exit(0);
}
if (!source.includes('const workspaceCacheKey = "mountainview_workspace_cache_v1";')) {
  throw new Error('MountainView session cache patch must run before native presence patch');
}
if (!source.includes('const workspaceTenant =')) {
  throw new Error('MountainView workspace parity patch must run before native presence patch');
}

source = source.replace(
  'const workspaceCacheKey = "mountainview_workspace_cache_v1";',
  'const workspaceCacheKey = "mountainview_workspace_cache_v1";\nconst presenceClientKey = "mountainview_presence_client_v1";',
);

const marker = `  useEffect(() => {\n    const timer = setTimeout(() => {\n      void autoArmGlassesBridge("startup");`;
if (!source.includes(marker)) throw new Error('MountainView startup effect marker missing');

const presenceEffect = `  useEffect(() => {\n    let cancelled = false;\n    let timer: ReturnType<typeof setInterval> | undefined;\n    const beat = async () => {\n      try {\n        let clientId = await SecureStore.getItemAsync(presenceClientKey);\n        if (!clientId) {\n          clientId = \`mv-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2)}\`;\n          await SecureStore.setItemAsync(presenceClientKey, clientId);\n        }\n        if (cancelled) return;\n        const displayName = String(workspace?.profile?.displayName ?? workspace?.profile?.username ?? workspaceTenant ?? "").trim() || "Guest";\n        await fetch("https://spmt.live/api/presence/heartbeat", {\n          method: "POST",\n          headers: { "content-type": "application/json" },\n          body: JSON.stringify({ appId: "mountainview", clientId, displayName })\n        });\n      } catch {\n        // Presence is observational and must never block MountainView.\n      }\n    };\n    void beat();\n    timer = setInterval(() => void beat(), 25_000);\n    return () => {\n      cancelled = true;\n      if (timer) clearInterval(timer);\n    };\n  }, [workspaceTenant, workspace?.profile?.displayName, workspace?.profile?.username]);\n\n`;

source = source.replace(marker, presenceEffect + marker);
await writeFile(mobilePath, source, 'utf8');
console.log(`patched ${mobilePath} with canonical SPMT native presence heartbeat`);
