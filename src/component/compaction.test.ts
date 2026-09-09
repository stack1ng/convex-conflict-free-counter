import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import workpoolTest from "@convex-dev/workpool/test";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import schema from "./schema.js";
import { modules, enableSnapshotQueries } from "./setup.test.js";
import { api, components, internal } from "./_generated/api.js";
import { RESET_BATCH_SIZE } from "./compaction.js";
import {
  COMPACTION_READ_BUDGET,
  MAX_COMPACTION_LOGS,
  COMPACTION_LANES,
  POLL_INTERVAL_MS,
} from "./shared.js";

function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  enableSnapshotQueries();
  workpoolTest.register(t, "workpool");
  return t;
}
async function finish(t: ReturnType<typeof setup>) {
  await (
    t.finishAllScheduledFunctions as (
      advance: () => void,
      iterations: number,
    ) => Promise<void>
  )(() => vi.advanceTimersToNextTimer(), 10000);
}
async function poll(t: ReturnType<typeof setup>) {
  vi.setSystemTime(Date.now() + POLL_INTERVAL_MS);
  await t.action(internal.maintenance.poll, {});
  await finish(t);
}
async function logs(
  t: ReturnType<typeof setup>,
  key: string,
  count: number,
  legacy = false,
) {
  return t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i < count; i++)
      ids.push(
        await ctx.db.insert("counter_logs", {
          key,
          delta: 1,
          ...(legacy ? {} : { lane: 0 }),
        }),
      );
    return ids;
  });
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded discovery and compaction", () => {
  test("hot writes schedule nothing and create no maintenance state", async () => {
    const t = setup();
    await t.mutation(api.public.addMany, {
      deltas: Array.from({ length: 2000 }, (_, i) => ({
        key: `key${i}`,
        delta: 1,
      })),
    });
    await t.mutation(api.public.add, { key: "key0", delta: 1 });
    await t.run(async (ctx) => {
      expect(
        await ctx.db.system.query("_scheduled_functions").collect(),
      ).toHaveLength(0);
      for (const table of [
        "compaction_leases",
        "compaction_lanes",
        "compaction_config",
      ] as const)
        expect(await ctx.db.query(table).collect()).toHaveLength(0);
    });
  });
  test("repeated discovery enqueues at most one job per lane", async () => {
    const t = setup();
    await logs(t, "hot", 2000);
    await t.action(internal.maintenance.poll, {});
    const before = await t.run((ctx) =>
      ctx.db.query("compaction_lanes").collect(),
    );
    for (let i = 0; i < 20; i++) {
      await t.action(internal.maintenance.poll, {});
      await t.mutation(internal.maintenance.enqueueLanes, {
        lanes: [0],
      });
    }
    expect(
      await t.run((ctx) => ctx.db.query("compaction_lanes").collect()),
    ).toEqual(before);
    await finish(t);
    expect(
      await t.query(api.public.read, { key: "hot", logScanLimit: 0 }),
    ).toMatchObject({ count: 2000 });
    expect(await t.query(api.maintenance.health, {})).toMatchObject({
      oldestPendingDeltaAt: null,
      outstandingLanes: 0,
      failedLanes: 0,
    });
  });
  test("large backlogs continue without another poll", async () => {
    const t = setup();
    await logs(t, "hot", MAX_COMPACTION_LOGS * 4 + 7);
    await poll(t);
    expect(
      await t.query(api.public.read, { key: "hot", logScanLimit: 0 }),
    ).toMatchObject({ count: MAX_COMPACTION_LOGS * 4 + 7 });
    expect(
      (await t.query(api.maintenance.health, {})).oldestPendingDeltaAt,
    ).toBeNull();
  }, 30000);
  test("many keys share the fixed lane set and all reach snapshots", async () => {
    const t = setup();
    await t.mutation(api.public.addMany, {
      deltas: Array.from({ length: 1200 }, (_, i) => ({
        key: `key${i}`,
        delta: i - 600,
      })),
    });
    await poll(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("counter_logs").collect()).toHaveLength(0);
      expect(await ctx.db.query("counter_snapshots").collect()).toHaveLength(
        1200,
      );
      expect(
        (await ctx.db.query("compaction_lanes").collect()).length,
      ).toBeLessThanOrEqual(COMPACTION_LANES);
    });
  }, 30000);
  test("selection is bounded by bytes as well as rows", async () => {
    const t = setup();
    const key = "large".repeat(20000);
    await logs(t, key, 30);
    const lane = await t.run((ctx) =>
      ctx.db.insert("compaction_lanes", {
        lane: 0,
        failures: 0,
        retryAt: 0,
      }),
    );
    const selected = await t.query(internal.maintenance.selectBatch, { lane });
    expect(selected.ids.length).toBeGreaterThan(0);
    expect(selected.ids.length).toBeLessThan(30);
    expect(selected.more).toBe(true);
    await poll(t);
    expect(
      (await t.query(api.public.read, { key, logScanLimit: 0 })).count,
    ).toBe(30);
  });
  test("partial reads and health expose stale data", async () => {
    const t = setup();
    await logs(t, "hot", 20);
    expect(
      await t.query(api.public.read, { key: "hot", logScanLimit: 5 }),
    ).toEqual({ count: 5, fullyConsistent: false });
    expect(
      (await t.query(api.maintenance.health, {})).oldestPendingDeltaAt,
    ).not.toBeNull();
    await poll(t);
    expect(await t.query(api.public.read, { key: "hot" })).toEqual({
      count: 20,
      fullyConsistent: true,
    });
  });
});

describe("idempotency and reset fencing", () => {
  test("replayed IDs cannot double-count or consume later writes", async () => {
    const t = setup();
    const ids = await logs(t, "hot", 3);
    await t.mutation(api.public.add, { key: "hot", delta: 100 });
    expect(
      await t.mutation(internal.maintenance.applyBatch, {
        ids: [...ids, ids[0]],
      }),
    ).toBe(3);
    expect(await t.mutation(internal.maintenance.applyBatch, { ids })).toBe(0);
    expect(await t.query(api.public.read, { key: "hot" })).toEqual({
      count: 103,
      fullyConsistent: true,
    });
    await poll(t);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(103);
  });
  test("reset after selection cannot resurrect old deltas", async () => {
    const t = setup();
    const ids = await logs(t, "hot", 20);
    await t.mutation(api.public.reset, { key: "hot" });
    await t.mutation(api.public.add, { key: "hot", delta: 7 });
    await t.mutation(internal.maintenance.applyBatch, { ids });
    await poll(t);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(7);
  });
  test("a pending reset still fences compaction after its old deadline", async () => {
    const t = setup();
    await logs(t, "hot", RESET_BATCH_SIZE + 100);
    await t.mutation(api.public.reset, { key: "hot" });
    const remaining = await t.run((ctx) =>
      ctx.db.query("counter_logs").collect(),
    );
    vi.setSystemTime(Date.now() + 120000);
    expect(
      await t.mutation(internal.maintenance.applyBatch, {
        ids: remaining.map((log) => log._id),
      }),
    ).toBe(0);
    await t.mutation(api.public.add, { key: "hot", delta: 9 });
    await finish(t);
    await poll(t);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(9);
  }, 30000);
  test("a second reset fences the first clear continuation", async () => {
    const t = setup();
    await logs(t, "hot", 8100);
    await t.mutation(api.public.reset, { key: "hot" });
    await t.mutation(api.public.reset, { key: "hot" });
    await t.mutation(api.public.add, { key: "hot", delta: 11 });
    await finish(t);
    await poll(t);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(11);
  }, 30000);
});

describe("recovery and upgrade", () => {
  test("jobs starting minutes late still compact their data", async () => {
    const t = setup();
    await logs(t, "hot", 1200);
    await t.action(internal.maintenance.poll, {});
    vi.setSystemTime(Date.now() + 10 * 60000);
    await finish(t);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(1200);
    expect((await t.query(api.maintenance.health, {})).outstandingLanes).toBe(
      0,
    );
  }, 30000);
  test("canceled work is rediscovered without a new write", async () => {
    const t = setup();
    await logs(t, "hot", 10);
    await t.action(internal.maintenance.poll, {});
    const lane = await t.run((ctx) => ctx.db.query("compaction_lanes").first());
    await t.run((ctx) =>
      new Workpool(components.workpool, {}).cancel(ctx, lane!.workId as WorkId),
    );
    await finish(t);
    vi.setSystemTime(Date.now() + 60000);
    await poll(t);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(10);
  });
  test("overflow is visible and recovers after reset without poisoning snapshots", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("counter_logs", {
        key: "hot",
        delta: 1e308,
        lane: 0,
      });
      await ctx.db.insert("counter_logs", {
        key: "hot",
        delta: 1e308,
        lane: 0,
      });
    });
    await poll(t);
    expect((await t.query(api.maintenance.health, {})).failedLanes).toBe(1);
    expect(
      await t.run((ctx) => ctx.db.query("counter_snapshots").collect()),
    ).toHaveLength(0);
    await t.mutation(api.public.reset, { key: "hot" });
    await t.mutation(api.public.add, { key: "hot", delta: 1 });
    vi.setSystemTime(Date.now() + 60000);
    await poll(t);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(1);
    expect((await t.query(api.maintenance.health, {})).failedLanes).toBe(0);
  });
  test("legacy logs join the same snapshot lane as new writes before compaction", async () => {
    const t = setup();
    const oldIds = await logs(t, "hot", 3, true);
    await logs(t, "hot", 2);
    expect(
      await t.mutation(internal.maintenance.applyBatch, { ids: oldIds }),
    ).toBe(3);
    expect(
      await t.run((ctx) => ctx.db.query("counter_snapshots").collect()),
    ).toHaveLength(0);
    await poll(t);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(5);
  });
  test("a legacy reset without a job link survives upgrade", async () => {
    const t = setup();
    await logs(t, "hot", 3, true);
    await t.run(async (ctx) => {
      const lease = await ctx.db.insert("compaction_leases", {
        key: "hot",
        expires_at: Date.now() - 1,
      });
      await ctx.scheduler.runAfter(0, internal.compaction.clearKeyBatch, {
        key: "hot",
        lease,
        boundaryCreationTime: (await ctx.db
          .query("counter_logs")
          .order("desc")
          .first())!._creationTime,
        compactionDelay: 15000,
        compactionLeaseDuration: 60000,
      });
    });
    vi.setSystemTime(Date.now() + 1);
    await t.mutation(api.public.add, { key: "hot", delta: 7 });
    await poll(t);
    await poll(t);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(7);
  });
  test("legacy jobs stop rescheduling and their leases are cleaned", async () => {
    const t = setup();
    await logs(t, "hot", 3, true);
    await t.run(async (ctx) => {
      const lease = await ctx.db.insert("compaction_leases", {
        key: "hot",
        expires_at: Date.now() + 60000,
      });
      const job = await ctx.scheduler.runAfter(
        0,
        internal.compaction.compactLogs,
        {
          key: "hot",
          lease,
          compactionDelay: 15000,
          compactionLeaseDuration: 60000,
        },
      );
      await ctx.db.patch("compaction_leases", lease, { job });
    });
    await poll(t);
    await poll(t);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(3);
    expect(
      await t.run((ctx) => ctx.db.query("compaction_leases").collect()),
    ).toHaveLength(0);
  });
  test("canceled reset cleanup recovers using its original boundary", async () => {
    const t = setup();
    await logs(t, "hot", RESET_BATCH_SIZE + 100);
    await t.mutation(api.public.reset, { key: "hot" });
    await t.run(async (ctx) => {
      const lease = await ctx.db.query("compaction_leases").first();
      await ctx.scheduler.cancel(lease!.job!);
    });
    vi.setSystemTime(Date.now() + 1);
    await t.mutation(api.public.add, { key: "hot", delta: 9 });
    await poll(t);
    await poll(t);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(9);
  }, 30000);
  test("ordinary legacy leases do not block compaction while cleanup catches up", async () => {
    const t = setup();
    const ids = await logs(t, "hot", 3);
    await t.run(async (ctx) => {
      const lease = await ctx.db.insert("compaction_leases", {
        key: "hot",
        expires_at: Date.now() + 60000,
      });
      const job = await ctx.scheduler.runAfter(
        60000,
        internal.compaction.compactLogs,
        {
          key: "hot",
          lease,
          compactionDelay: 15000,
          compactionLeaseDuration: 60000,
        },
      );
      await ctx.db.patch("compaction_leases", lease, { job });
    });
    expect(await t.mutation(internal.maintenance.applyBatch, { ids })).toBe(3);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(3);
  });
});

describe("configuration", () => {
  test("settings are component-wide and writes cannot change them", async () => {
    const t = setup();
    await t.mutation(api.maintenance.configure, {
      maxParallelism: 2,
      pollIntervalMs: 10000,
    });
    await t.mutation(api.public.add, {
      key: "hot",
      delta: 1,
      compactionDelay: 1,
    });
    await poll(t);
    expect(await t.query(api.maintenance.health, {})).toMatchObject({
      maxParallelism: 2,
      pollIntervalMs: 10000,
    });
  });
  test.each([0, -1, 1.5, COMPACTION_LANES + 1, Infinity, NaN])(
    "rejects parallelism %s",
    async (maxParallelism) => {
      const t = setup();
      await expect(
        t.mutation(api.maintenance.configure, {
          maxParallelism,
          pollIntervalMs: 5000,
        }),
      ).rejects.toThrow(/maxParallelism/);
    },
  );
  test.each([0, -1, 4999, 5000.5, Infinity, NaN])(
    "rejects poll interval %s",
    async (pollIntervalMs) => {
      const t = setup();
      await expect(
        t.mutation(api.maintenance.configure, {
          maxParallelism: 4,
          pollIntervalMs,
        }),
      ).rejects.toThrow(/pollIntervalMs/);
    },
  );
});

describe("snapshot lanes", () => {
  test("a hot key compacts across every lane without conflicting snapshots", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      for (let lane = 0; lane < COMPACTION_LANES; lane++) {
        for (let i = 0; i < 20; i++)
          await ctx.db.insert("counter_logs", { key: "hot", delta: 1, lane });
      }
    });
    await poll(t);
    const snapshots = await t.run((ctx) =>
      ctx.db.query("counter_snapshots").collect(),
    );
    expect(snapshots).toHaveLength(COMPACTION_LANES);
    expect(new Set(snapshots.map((row) => row.lane)).size).toBe(
      COMPACTION_LANES,
    );
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(
      COMPACTION_LANES * 20,
    );
  });
  test("legacy snapshots are summed with new lanes and reset removes both", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("counter_snapshots", { key: "hot", count: 100 });
      for (let lane = 0; lane < COMPACTION_LANES; lane++)
        await ctx.db.insert("counter_logs", {
          key: "hot",
          delta: lane + 1,
          lane,
        });
    });
    await poll(t);
    expect(
      (await t.query(api.public.read, { key: "hot", logScanLimit: 0 })).count,
    ).toBe(100 + (COMPACTION_LANES * (COMPACTION_LANES + 1)) / 2);
    await t.mutation(api.public.reset, { key: "hot" });
    expect(
      await t.run((ctx) => ctx.db.query("counter_snapshots").collect()),
    ).toHaveLength(0);
    expect((await t.query(api.public.read, { key: "hot" })).count).toBe(0);
  });
  test("overflow across lanes fails the read instead of reporting a non-finite count", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("counter_snapshots", {
        key: "hot",
        count: 1e308,
        lane: 0,
      });
      await ctx.db.insert("counter_snapshots", {
        key: "hot",
        count: 1e308,
        lane: 1,
      });
    });
    await expect(
      t.query(api.public.read, { key: "hot", logScanLimit: 0 }),
    ).rejects.toThrow(/overflow/);
  });
  test("batch selection includes the per-key read cost", async () => {
    const t = setup();
    const lane = await t.run(async (ctx) => {
      for (let i = 0; i < 2000; i++)
        await ctx.db.insert("counter_logs", {
          key: `key${i}`,
          delta: 1,
          lane: 0,
        });
      return ctx.db.insert("compaction_lanes", {
        lane: 0,
        failures: 0,
        retryAt: 0,
      });
    });
    const selected = await t.query(internal.maintenance.selectBatch, { lane });
    expect(selected.ids.length * 6).toBeLessThanOrEqual(COMPACTION_READ_BUDGET);
    expect(selected.more).toBe(true);
    await t.mutation(internal.maintenance.applyBatch, { ids: selected.ids });
    await poll(t);
    expect(
      (await t.query(api.maintenance.health, {})).oldestPendingDeltaAt,
    ).toBeNull();
  }, 30000);
});
