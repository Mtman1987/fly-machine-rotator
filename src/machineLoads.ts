import { FlyApiClient } from "./flyClient.js";
import { getManagedFlyApps } from "./flyObservability.js";

export type MachineLoad = {
  appName: string; machineId?: string; region?: string; state: string; sampledAt: string;
  cpus?: number; cpuBusyPercent?: number; cpuIdlePercent?: number; cpuStealPercent?: number; cpuWaitPercent?: number;
  load1?: number; load5?: number; load15?: number; ramUsedMb?: number; ramTotalMb?: number; sampleSeconds?: number;
  unavailable?: string;
};
// The first eight CPU fields exclude guest fields already included in user/nice.
// Steal is host time denied to this VM, measured over the same one-second window.
export const MACHINE_LOAD_PROBE = `awk 'BEGIN {
  getline line < "/proc/stat"; close("/proc/stat"); split(line,a," ");
  system("sleep 1"); getline line < "/proc/stat"; close("/proc/stat"); split(line,b," ");
  total=0; for(i=2;i<=9;i++) total+=b[i]-a[i];
  if(total<=0) exit 1;
  idle=b[5]-a[5]; wait=b[6]-a[6]; steal=b[9]-a[9];
  cpus=0; while((getline line < "/proc/stat")>0) if(line ~ /^cpu[0-9]+ /) cpus++; close("/proc/stat");
  getline line < "/proc/loadavg"; close("/proc/loadavg"); split(line,l," ");
  while((getline line < "/proc/meminfo")>0) {split(line,m," "); if(m[1]=="MemTotal:") mt=m[2]; if(m[1]=="MemAvailable:") ma=m[2]} close("/proc/meminfo");
  if(mt<=0 || cpus<=0) exit 1;
  printf "{\\"cpus\\":%d,\\"cpuBusyPercent\\":%.1f,\\"cpuIdlePercent\\":%.1f,\\"cpuWaitPercent\\":%.1f,\\"cpuStealPercent\\":%.1f,\\"load1\\":%s,\\"load5\\":%s,\\"load15\\":%s,\\"ramTotalMb\\":%.0f,\\"ramUsedMb\\":%.0f,\\"sampleSeconds\\":1}\\n",cpus,100*(total-idle-wait-steal)/total,100*idle/total,100*wait/total,100*steal/total,l[1],l[2],l[3],mt/1024,(mt-ma)/1024;
}'`;

export function parseMachineLoad(stdout: string): Pick<MachineLoad, "cpus" | "cpuBusyPercent" | "cpuIdlePercent" | "cpuWaitPercent" | "cpuStealPercent" | "load1" | "load5" | "load15" | "ramTotalMb" | "ramUsedMb" | "sampleSeconds"> {
  const raw = JSON.parse(stdout.trim());
  const fields = ["cpus", "cpuBusyPercent", "cpuIdlePercent", "cpuWaitPercent", "cpuStealPercent", "load1", "load5", "load15", "ramTotalMb", "ramUsedMb", "sampleSeconds"];
  const out: Record<string, number> = {};
  for (const field of fields) {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field.endsWith("Percent") && value > 100)) throw new Error("Invalid machine load sample");
    out[field] = value;
  }
  if (out.cpus < 1 || out.ramTotalMb <= 0 || out.sampleSeconds !== 1) throw new Error("Invalid machine load sample");
  return out;
}

export async function collectMachineLoads(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<MachineLoad[]> {
  const hostname = (env.FLY_API_HOSTNAME || "https://api.machines.dev").replace(/\/$/, "");
  const client = new FlyApiClient({ token: env.FLY_API_TOKEN || "", hostname, minIntervalMs: 150, maxRetries: 0, requestTimeoutMs: 6000 });
  const result: MachineLoad[] = [];
  const apps = getManagedFlyApps(env);
  // Partner services never enter inventory or probes even if the allowlist drifts.
  const managed = apps.filter(app => !/(?:^|[-_])(?:mika|miniature|atherea|atheria|aetherra)(?:[-_]|$)/i.test(app));
  for (let offset = 0; offset < managed.length; offset += 3) {
    await Promise.all(managed.slice(offset, offset + 3).map(async appName => {
      let machines;
      try { machines = await client.listMachines(appName); }
      catch { result.push({ appName, state: "unknown", sampledAt: new Date().toISOString(), unavailable: "inventory request failed" }); return; }
      for (const machine of machines) {
        const row: MachineLoad = { appName, machineId: machine.id, region: machine.region, state: machine.state, sampledAt: new Date().toISOString() };
        if (machine.state === "started") {
          try {
            const response = await fetchImpl(`${hostname}/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machine.id)}/exec`, {
              method: "POST", headers: { authorization: `Bearer ${env.FLY_API_TOKEN}`, "content-type": "application/json" },
              body: JSON.stringify({ cmd: MACHINE_LOAD_PROBE, timeout: 5 }), signal: AbortSignal.timeout(6500), redirect: "error",
            });
            if (!response.ok) { await response.body?.cancel(); throw new Error("probe rejected"); }
            const output = await response.json() as { stdout?: string; exit_code?: number };
            if (output.exit_code !== 0 || typeof output.stdout !== "string") throw new Error("probe failed");
            Object.assign(row, parseMachineLoad(output.stdout));
          } catch { row.unavailable = "load probe did not complete"; }
        }
        row.sampledAt = new Date().toISOString(); result.push(row);
      }
    }));
  }
  return result.sort((a,b) => a.appName.localeCompare(b.appName) || String(a.machineId).localeCompare(String(b.machineId)));
}

export function renderMachineLoads(rows: MachineLoad[]): string[] {
  return rows.map(row => `${row.appName} ${row.machineId || "?"} ${row.state}: ` + (row.cpuStealPercent === undefined
    ? row.unavailable || "no live sample (machine stopped)"
    : `CPU busy ${row.cpuBusyPercent}% / steal ${row.cpuStealPercent}% / wait ${row.cpuWaitPercent}% • load ${row.load1}/${row.load5}/${row.load15} (${row.cpus} vCPU) • RAM ${row.ramUsedMb}/${row.ramTotalMb} MB`));
}
