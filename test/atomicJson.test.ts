import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAtomicJson } from "../src/atomicJson.js";

describe("atomic coder metadata", () => {
  it("publishes a complete replacement and leaves no temporary artifact", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "coder-json-"));
    try {
      const file = join(dir, "job.json");
      await fs.writeFile(file, '{"status":"running"}');
      await writeAtomicJson(file, { status: "failed", error: "disk_full" });
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ status: "failed", error: "disk_full" });
      expect(await fs.readdir(dir)).toEqual(["job.json"]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  for (const stage of ["write", "sync", "rename"] as const) {
    for (const existing of [false, true]) {
      it(`preserves a complete record on ENOSPC at ${stage} (existing=${existing})`, async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), "coder-enospc-"));
        try {
          const file = join(dir, "job.json");
          const previous = '{"status":"running","changedFiles":["valid.ts"]}';
          if (existing) await fs.writeFile(file, previous);
          const diskFull = Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
          const io = {
            open: async (name: string, flags: string) => {
              const handle = await fs.open(name, flags);
              return {
                writeFile: stage === "write" && flags === "wx" ? async () => {
                  await handle.writeFile('{"incomplete":');
                  throw diskFull;
                } : handle.writeFile.bind(handle),
                sync: stage === "sync" && flags === "wx" ? async () => { throw diskFull; } : handle.sync.bind(handle),
                close: handle.close.bind(handle),
              };
            },
            rename: stage === "rename" ? async () => { throw diskFull; } : fs.rename,
            rm: fs.rm,
          };
          await expect(writeAtomicJson(file, { status: "completed" }, io)).rejects.toMatchObject({ code: "ENOSPC" });
          if (existing) expect(await fs.readFile(file, "utf8")).toBe(previous);
          else await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readdir(dir)).toEqual(existing ? ["job.json"] : []);
        } finally { await fs.rm(dir, { recursive: true, force: true }); }
      });
    }
  }
});
