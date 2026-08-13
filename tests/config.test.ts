import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDotEnv, loadRuntimeSettings } from "../src/config.js";

test("loads a local env file without replacing an existing process value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-env-"));
  const variable = `ASSISTANT_ENV_TEST_${randomUUID().replaceAll("-", "")}`;
  const file = join(directory, ".env");
  const previous = process.env[variable];

  try {
    await writeFile(file, `# local secret\nexport ${variable} = \"from-file\"\n`, "utf8");
    delete process.env[variable];
    await loadDotEnv(file);
    assert.equal(process.env[variable], "from-file");

    await writeFile(file, `${variable}=second-value\n`, "utf8");
    await loadDotEnv(file);
    assert.equal(process.env[variable], "from-file");
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing local env files are ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-env-missing-"));
  try {
    await assert.doesNotReject(() => loadDotEnv(join(directory, ".env")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime settings load the env file next to config.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-settings-env-"));
  const variable = `ASSISTANT_SETTINGS_ENV_TEST_${randomUUID().replaceAll("-", "")}`;
  const configPath = join(directory, "config.json");
  const previous = process.env[variable];

  try {
    await writeFile(configPath, JSON.stringify({ memory: { enabled: false } }), "utf8");
    await writeFile(join(directory, ".env"), `${variable}=settings-file\n`, "utf8");
    delete process.env[variable];
    await loadRuntimeSettings(configPath);
    assert.equal(process.env[variable], "settings-file");
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
