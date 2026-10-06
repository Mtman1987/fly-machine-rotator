// Narrow saved-capacity correction. Never start a stopped Machine.
const targets = [
 { app: 'spmt-live', id: '8e13eeb7311d68', cpus: 2, memory: 4096, group: 'xbox' },
 { app: 'fly-builder-summer-smoke-5183', id: 'd8d2540c046028', cpus: 4, memory: 8192 }
];
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const token = process.env.FLY_API_TOKEN;
async function fly(args) {
 try { const r = await exec('flyctl', args, { env: process.env, timeout: 180000, maxBuffer: 8*1024*1024 }); return r.stdout; }
 catch { throw new Error('Fly capacity operation failed; no raw output exported'); }
}
async function read(target) {
 const machines = JSON.parse(await fly(['machines', 'list', '--app', target.app, '--json']));
 const machine = machines.find(m => m.id === target.id);
 if (!machine) throw new Error('Target Machine unavailable');
 return machine;
}
const results = [];
try {
 if (!token) throw new Error('Fly authentication unavailable');
 for (const target of targets) {
  const before = await read(target);
  if (before.state !== 'stopped') throw new Error('Target must remain stopped: ' + target.app);
  const config = structuredClone(before.config);
  if (config.guest.memory_mb !== target.memory) throw new Error('Unexpected RAM allocation');
  if (target.group && config.metadata?.fly_process_group !== target.group) throw new Error('Unexpected process group');
  const changed = config.guest.cpu_kind !== 'shared' || config.guest.cpus !== target.cpus;
  if (changed) {
   await fly(['machine', 'update', target.id, '--app', target.app, '--vm-cpu-kind', 'shared', '--vm-cpus', String(target.cpus), '--skip-start', '--yes']);
  }
  const after = await read(target);
  if (after.state !== 'stopped' || after.config.guest.cpu_kind !== 'shared' || after.config.guest.cpus !== target.cpus || after.config.guest.memory_mb !== target.memory) throw new Error('Saved capacity verification failed');
  if (JSON.stringify(before.config.mounts || []) !== JSON.stringify(after.config.mounts || [])) throw new Error('Volume attachment changed');
  results.push({ app: target.app, id: target.id, changed, state: after.state, cpuKind: 'shared', cpus: target.cpus, memoryMb: target.memory });
 }
 process.stdout.write(JSON.stringify({ ok: true, machines: results }, null, 2));
} catch (error) {
 process.stdout.write(JSON.stringify({ ok: false, machines: results, error: error.message }, null, 2));
 process.exitCode = 1;
}
