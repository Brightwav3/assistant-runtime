import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export interface RunTrace {
  path: string;
  record(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

function timestampPart(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Creates one append-only raw event stream for a runtime process. */
export async function createRunTrace(directory: string, now = new Date()): Promise<RunTrace> {
  await mkdir(directory, { recursive: true });
  const stamp = timestampPart(now);
  let path = "";
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${String(attempt).padStart(2, "0")}`;
    const candidate = join(directory, `trace-${stamp}${suffix}.jsonl`);
    try {
      const handle = await open(candidate, "wx");
      await handle.close();
      path = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  let queue = Promise.resolve();
  return {
    path,
    record: (event) => {
      const line = `${JSON.stringify(event)}\n`;
      queue = queue.then(() => appendFile(path, line, "utf8"));
    },
    close: () => queue,
  };
}
