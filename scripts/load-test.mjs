import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { ConvexHttpClient } from "convex/browser";

assert(process.env.COUNTER_LAB_CREDENTIALS, "Missing COUNTER_LAB_CREDENTIALS");
const credentials = JSON.parse(
  await readFile(process.env.COUNTER_LAB_CREDENTIALS, "utf8"),
);
assert.equal(
  credentials.deploymentType,
  "dev",
  "Load tests are restricted to development deployments",
);
assert.equal(
  process.env.COUNTER_LAB_CONFIRM,
  credentials.deploymentName,
  "Explicitly confirm the isolated deployment name",
);
assert(process.env.COUNTER_LAB_LOG, "Missing COUNTER_LAB_LOG");
assert(process.env.COUNTER_LAB_RESULT, "Missing COUNTER_LAB_RESULT");
const client = new ConvexHttpClient(credentials.url);
client.setAdminAuth(credentials.adminKey);
const invoke = (name, args = {}, component) =>
  client.function(name, component, args);

const scenarios = {
  smallUnique: { total: 5000, batch: 10, keys: 5000, concurrency: 32 },
  smoke: { total: 1000, batch: 10, keys: 20, concurrency: 4 },
  hot: { total: 200000, batch: 100, keys: 1, concurrency: 128 },
  broad: { total: 200000, batch: 100, keys: 10000, concurrency: 64 },
  million: { total: 1000000, batch: 500, keys: 50000, concurrency: 64 },
  concurrency: { total: 200000, batch: 100, keys: 4096, concurrency: 256 },
  steady: {
    total: 120000,
    batch: 100,
    keys: 64,
    concurrency: 16,
    rate: 2000,
  },
  sustained: {
    total: 480000,
    batch: 100,
    keys: 4096,
    concurrency: 32,
    rate: 4000,
  },
};
const scenario = process.argv[2];
const config = scenarios[scenario];
assert(config, `Choose ${Object.keys(scenarios).join(", ")}`);
const component = "conflictFreeCounter";
const health = () => invoke("maintenance:health", {}, component);
const run = `${scenario}-${Date.now()}`;
const startedAt = Date.now();
const initialHealth = await health();
assert.equal(
  initialHealth.oldestPendingDeltaAt,
  null,
  "Drain earlier runs before starting a measurement",
);
const expected = new Float64Array(config.keys);
const latencies = [];
const samples = [];
const errors = [];
let next = 0;
let successful = 0;
let done = false;
let latestHealth = initialHealth;
let observedAt = startedAt;
const workStarted = performance.now();
const observer = (async () => {
  while (!done) {
    try {
      const state = await health();
      latestHealth = state;
      observedAt = Date.now();
      samples.push({
        elapsedMs: Date.now() - startedAt,
        ...state,
        ageMs:
          state.oldestPendingDeltaAt === null
            ? 0
            : Math.max(0, Date.now() - state.oldestPendingDeltaAt),
      });
      await invoke(`loadTest:scheduleProbe`, { run });
    } catch (e) {
      errors.push({ observer: String(e) });
    }
    if (samples.length % 5 === 0)
      console.log(
        JSON.stringify({
          run,
          written: successful * config.batch,
          latest: samples.at(-1),
        }),
      );
    await delay(1000);
  }
})();
await Promise.all(
  Array.from({ length: config.concurrency }, async () => {
    for (;;) {
      const offset = next;
      next += config.batch;
      if (offset >= config.total) return;
      if (config.rate)
        await delay(
          Math.max(
            0,
            workStarted + (offset / config.rate) * 1000 - performance.now(),
          ),
        );
      const start = performance.now();
      try {
        await invoke(`loadTest:write`, {
          run,
          offset,
          batch: config.batch,
          keys: config.keys,
        });
        latencies.push(performance.now() - start);
        successful++;
        for (let i = 0; i < config.batch; i++)
          expected[(offset + i) % config.keys]++;
      } catch (e) {
        errors.push({ offset, error: String(e) });
      }
    }
  }),
);
const writesFinishedAt = Date.now();
const drainDeadline = Date.now() + 30 * 60000;
for (;;) {
  if (
    observedAt >= writesFinishedAt &&
    latestHealth.oldestPendingDeltaAt === null &&
    latestHealth.outstandingLanes === 0
  )
    break;
  if (Date.now() > drainDeadline) {
    errors.push({ drainTimeout: latestHealth });
    break;
  }
  await delay(1000);
}
const drainedAt = Date.now();
done = true;
await observer;
const receipts = await invoke(`loadTest:receipts`, { run });
const mismatches = [];
let nextRead = 0;
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (;;) {
      const offset = nextRead;
      nextRead += 100;
      if (offset >= config.keys) return;
      const values = await invoke(`loadTest:counts`, {
        run,
        offset,
        keys: Math.min(100, config.keys - offset),
      });
      for (let i = 0; i < values.length; i++)
        if (values[i] !== expected[offset + i])
          mismatches.push({
            key: offset + i,
            expected: expected[offset + i],
            actual: values[i],
          });
    }
  }),
);
const probes = await invoke(`loadTest:probeResults`, { run });
const percentile = (values, fraction) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
    : null;
};
const rawLogs = (await readFile(process.env.COUNTER_LAB_LOG, "utf8"))
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const executions = rawLogs.filter(
  (row) =>
    row.kind === "Completion" &&
    row.timestamp * 1000 >= startedAt &&
    row.timestamp * 1000 <= drainedAt,
);
const byFunction = {};
const activity = executions
  .filter(
    (row) =>
      row.componentPath === component &&
      row.identifier === "maintenance:compact",
  )
  .flatMap((row) => [
    { at: row.executionTimestamp, change: 1 },
    { at: row.timestamp, change: -1 },
  ])
  .sort((a, b) => a.at - b.at || a.change - b.change);
let active = 0;
let maxActiveCompactors = 0;
for (const event of activity) {
  active += event.change;
  maxActiveCompactors = Math.max(maxActiveCompactors, active);
}
for (const row of executions) {
  const name = `${row.componentPath || "app"}/${row.identifier}`;
  const entry = (byFunction[name] ??= {
    calls: 0,
    failed: 0,
    occ: 0,
    retryCount: 0,
    scheduled: 0,
    readDocs: 0,
    writeDocs: 0,
    maxMs: 0,
  });
  entry.calls++;
  entry.failed += row.error ? 1 : 0;
  entry.occ += row.occInfo ? 1 : 0;
  entry.retryCount += row.willRetry ? 1 : 0;
  entry.scheduled += row.caller === "Scheduler" ? 1 : 0;
  entry.readDocs += row.usageStats?.databaseReadDocuments ?? 0;
  entry.writeDocs += row.usageStats?.databaseWriteDocuments ?? 0;
  entry.maxMs = Math.max(entry.maxMs, row.executionTime * 1000);
}
const report = {
  run,
  deployment: credentials.deploymentName,
  scenario,
  config,
  startedAt,
  writesFinishedAt,
  drainedAt,
  writeSeconds: (writesFinishedAt - startedAt) / 1000,
  drainSeconds: (drainedAt - writesFinishedAt) / 1000,
  successful,
  receipts,
  errors,
  mismatches,
  writeLatencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: percentile(latencies, 1),
  },
  schedulerProbeMs: {
    samples: probes.length,
    p50: percentile(probes, 0.5),
    p95: percentile(probes, 0.95),
    max: percentile(probes, 1),
  },
  maxPendingAgeMs: Math.max(...samples.map((sample) => sample.ageMs)),
  maxOutstandingLanes: Math.max(
    ...samples.map((sample) => sample.outstandingLanes),
  ),
  maxActiveCompactors,
  finalHealth: await health(),
  samples,
  byFunction,
};
await writeFile(
  process.env.COUNTER_LAB_RESULT,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      ...report,
      samples: undefined,
      byFunction: undefined,
      errors: errors.length,
      mismatches: mismatches.length,
    },
    null,
    2,
  ),
);
assert.equal(
  errors.length,
  0,
  "Load-test requests or drain failed; inspect report",
);
assert.equal(
  receipts,
  successful,
  "Counter writes and business receipts diverged",
);
assert.equal(
  mismatches.length,
  0,
  "Exact snapshot totals differ from committed writes",
);
assert.equal(report.finalHealth.failedLanes, 0, "Compaction lane failed");
