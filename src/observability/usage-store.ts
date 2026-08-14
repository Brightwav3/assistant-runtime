/**
 * Durable operational usage history for the running assistant.
 *
 * Usage is telemetry about the runtime, not something the user remembers, so it does
 * not go into Memory Core. It is append-only JSONL under the runtime state directory:
 * ignored, never committed, and holding only normalized metrics and correlation IDs —
 * no prompts, completions, memory bodies, provider payloads, credentials, or audio.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InMemoryUsageMeter, PriceCatalog } from "intelligence-core";
import type { ModelPriceEntry, UsageCostEstimate, UsageGroupKey, UsageMeter, UsageRecord, UsageSummary } from "intelligence-core";

export interface UsageStoreOptions {
  path?: string;
  catalog: PriceCatalog;
  maxRecords?: number;
  /** Injectable so tests never touch the filesystem. */
  append?: (line: string) => Promise<void>;
}

export class RuntimeUsageStore implements UsageMeter {
  private readonly memory: InMemoryUsageMeter;
  private readonly pending: string[] = [];
  private writing: Promise<void> = Promise.resolve();

  public constructor(private readonly options: UsageStoreOptions) {
    this.memory = new InMemoryUsageMeter({ catalog: options.catalog, ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }) });
  }

  public get catalog(): PriceCatalog { return this.options.catalog; }

  public record(record: UsageRecord): void {
    // The in-memory meter validates redaction first, so a record carrying content is
    // rejected before it can be appended to a file we cannot retract.
    this.memory.record(record);
    this.pending.push(`${JSON.stringify(record)}\n`);
  }

  public records(): readonly UsageRecord[] { return this.memory.records(); }
  public summarize(input: { from: string; to: string; groupBy: UsageGroupKey[] }): UsageSummary[] { return this.memory.summarize(input); }
  public forecast(input: { from: string; to: string; projectedCalls: number; scenario?: "average" | "p50" | "p95" }): UsageCostEstimate { return this.memory.forecast(input); }

  /** Writes are serialized so concurrent flushes cannot interleave partial lines. */
  public async flush(): Promise<void> {
    if (!this.pending.length) return this.writing;
    const batch = this.pending.splice(0, this.pending.length).join("");
    this.writing = this.writing.then(async () => {
      if (this.options.append) return this.options.append(batch);
      if (!this.options.path) return;
      await mkdir(dirname(this.options.path), { recursive: true });
      await appendFile(this.options.path, batch, "utf8");
    });
    return this.writing;
  }

  /** Reloads previously persisted records so a forecast survives a restart. */
  public async load(): Promise<number> {
    if (!this.options.path) return 0;
    let content: string;
    try {
      content = await readFile(this.options.path, "utf8");
    } catch {
      return 0;
    }
    let loaded = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.memory.record(JSON.parse(line) as UsageRecord);
        loaded += 1;
      } catch {
        // A truncated or malformed line is skipped rather than failing startup: telemetry
        // must never be the reason the assistant will not run.
      }
    }
    return loaded;
  }
}

export type { ModelPriceEntry };
