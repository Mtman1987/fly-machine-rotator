// Narrow saved-capacity correction. Never start a stopped Machine.
const targets = [
 { app: 'spmt-live', id: '8e13eeb7311d68', cpus: 2, memory: 4096, group: 'xbox' },
 { app: 'fly-builder-summer-smoke-5183', id: 'd8d2540c046028', cpus: 4, memory: 8192 }
];
const token = process.env.FLY_API_TOKEN;
async function api(path, body) {
 const response = await fetch('https://api.machines.dev/v1/apps/' + path, {
  method: body ? 'POST' : 'GET',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {})
 });
 if (!response.ok) throw new Error('Machines request failed with HTTP ' + response.status);
 return response.json();
}
const results = [];
try {
 if (!token) throw new Error('Fly authentication unavailable');
 for (const target of targets) {
  const path = target.app + '/machines/' + target.id;
  const before = await api(path);
  if (before.state !== 'stopped') throw new Error('Target must remain stopped: ' + target.app);
  const config = structuredClone(before.config);
  if (config.guest.memory_mb !== target.memory) throw new Error('Unexpected RAM allocation');
  if (target.group && config.metadata?.fly_process_group !== target.group) throw new Error('Unexpected process group');
  if (!before.version) throw new Error('Machine version unavailable');
  const changed = config.guest.cpu_kind !== 'shared' || config.guest.cpus !== target.cpus;
  if (changed) {
   config.guest = { ...config.guest, cpu_kind: 'shared', cpus: target.cpus };
   await api(path, { config, current_version: before.version, skip_launch: true });
  }
  const after = await api(path);
  if (after.state !== 'stopped' || after.config.guest.cpu_kind !== 'shared' || after.config.guest.cpus !== target.cpus || after.config.guest.memory_mb !== target.memory) throw new Error('Saved capacity verification failed');
  if (JSON.stringify(before.config.mounts || []) !== JSON.stringify(after.config.mounts || [])) throw new Error('Volume attachment changed');
  results.push({ app: target.app, id: target.id, changed, state: after.state, cpuKind: 'shared', cpus: target.cpus, memoryMb: target.memory });
 }
 process.stdout.write(JSON.stringify({ ok: true, machines: results }, null, 2));
} catch (error) {
 process.stdout.write(JSON.stringify({ ok: false, machines: results, error: error.message }, null, 2));
 process.exitCode = 1;
}
