import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

type AtomicJsonIo = {
  open: (file: string, flags: string) => Promise<Pick<FileHandle, "writeFile" | "sync" | "close">>;
  rename: typeof rename;
  rm: typeof rm;
};

// Never truncate a published record. ENOSPC, short writes and process interruption
// before rename leave the last complete version readable.
export async function writeAtomicJson(file: string, value: unknown, io: AtomicJsonIo = { open, rename, rm }): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle: Awaited<ReturnType<AtomicJsonIo["open"]>> | undefined;
  try {
    handle = await io.open(temporary, "wx");
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await io.rename(temporary, file);
    const directory = await io.open(dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await io.rm(temporary, { force: true }).catch(() => undefined);
  }
}
