import { getConvexSize, v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import schema from "./schema.js";
import {
  Workpool,
  vOnCompleteValidator,
  type WorkId,
} from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import {
  COMPACTION_READ_BUDGET,
  MAX_COMPACTION_LOGS,
  COMPACTION_LANES,
  DEFAULT_MAX_PARALLELISM,
  POLL_INTERVAL_MS,
  firstPendingLog,
} from "./shared.js";

const pool = new Workpool(components.workpool, {
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
});
const settings = { maxParallelism: v.number(), pollIntervalMs: v.number() };
const batchResult = v.object({ processed: v.number(), more: v.boolean() });
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

export const configure = mutation({
  args: settings,
  returns: v.null(),
  handler: async (ctx, config) => {
    if (
      !Number.isInteger(config.maxParallelism) ||
      config.maxParallelism < 1 ||
      config.maxParallelism > COMPACTION_LANES
    )
      throw new Error(
        `maxParallelism must be an integer between 1 and ${COMPACTION_LANES}`,
      );
    if (
      !Number.isSafeInteger(config.pollIntervalMs) ||
      config.pollIntervalMs < POLL_INTERVAL_MS
    )
      throw new Error(
        `pollIntervalMs must be an integer of at least ${POLL_INTERVAL_MS}`,
      );
    const existing = await ctx.db.query("compaction_config").first();
    if (existing) await ctx.db.patch("compaction_config", existing._id, config);
    else await ctx.db.insert("compaction_config", { ...config, lastPollAt: 0 });
    await ctx.runMutation(components.workpool.config.update, {
      maxParallelism: config.maxParallelism,
    });
    return null;
  },
});

export const preparePoll = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const now = Date.now();
    const config = await ctx.db.query("compaction_config").first();
    if (config && now - config.lastPollAt < config.pollIntervalMs) return false;
    if (config)
      await ctx.db.patch("compaction_config", config._id, { lastPollAt: now });
    else {
      await ctx.db.insert("compaction_config", {
        maxParallelism: DEFAULT_MAX_PARALLELISM,
        pollIntervalMs: POLL_INTERVAL_MS,
        lastPollAt: now,
      });
      await ctx.runMutation(components.workpool.config.update, {
        maxParallelism: DEFAULT_MAX_PARALLELISM,
      });
    }
    const leases = await paginator(ctx.db, schema)
      .query("compaction_leases")
      .paginate({
        cursor: config?.leaseCursor ?? null,
        numItems: 100,
      });
    for (const lease of leases.page) {
      if (!lease.job) continue;
      const job = await ctx.db.system.get("_scheduled_functions", lease.job);
      const clearing =
        lease.clearBefore !== undefined || job?.name.endsWith(":clearKeyBatch");
      if (!clearing) {
        await ctx.db.delete("compaction_leases", lease._id);
      } else if (
        job?.state.kind !== "pending" &&
        job?.state.kind !== "inProgress"
      ) {
        const boundary =
          lease.clearBefore ??
          (job?.args[0] as { boundaryCreationTime?: number } | undefined)
            ?.boundaryCreationTime;
        if (boundary === undefined) continue;
        const jobId = await ctx.scheduler.runAfter(
          0,
          internal.compaction.clearKeyBatch,
          {
            key: lease.key,
            lease: lease._id,
            boundaryCreationTime: boundary,
            compactionDelay: 0,
            compactionLeaseDuration: 0,
          },
        );
        await ctx.db.patch("compaction_leases", lease._id, {
          job: jobId,
          clearBefore: boundary,
        });
      }
    }
    const updatedConfig = await ctx.db.query("compaction_config").first();
    if (!updatedConfig) throw new Error("Compaction configuration missing");
    await ctx.db.patch("compaction_config", updatedConfig._id, {
      leaseCursor: leases.isDone ? null : leases.continueCursor,
    });
    return true;
  },
});

export const pendingLanes = internalQuery({
  args: {},
  returns: v.array(v.number()),
  handler: async (ctx) => {
    const lanes = Array.from({ length: COMPACTION_LANES + 1 }, (_, i) => i - 1);
    const logs = await Promise.all(
      lanes.map((lane) => firstPendingLog(ctx, lane === -1 ? undefined : lane)),
    );
    return lanes.filter((_, i) => logs[i] !== null);
  },
});

export const poll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!(await ctx.runMutation(internal.maintenance.preparePoll, {})))
      return null;
    const lanes = await ctx.runQuery(internal.maintenance.pendingLanes, {});
    await ctx.runMutation(internal.maintenance.enqueueLanes, { lanes });
    return null;
  },
});

async function enqueue(ctx: MutationCtx, lane: Id<"compaction_lanes">) {
  const workId = await pool.enqueueAction(
    ctx,
    internal.maintenance.compact,
    { lane },
    {
      onComplete: internal.maintenance.completed,
      context: { lane },
    },
  );
  await ctx.db.patch("compaction_lanes", lane, { workId });
}

export const enqueueLanes = internalMutation({
  args: { lanes: v.array(v.number()) },
  returns: v.null(),
  handler: async (ctx, { lanes }) => {
    if (lanes.length > COMPACTION_LANES + 1)
      throw new Error("Too many compaction lanes");
    for (const lane of new Set(lanes)) {
      if (!Number.isInteger(lane) || lane < -1 || lane >= COMPACTION_LANES)
        throw new Error("Invalid compaction lane");
      const existing = await ctx.db
        .query("compaction_lanes")
        .withIndex("by_lane", (q) => q.eq("lane", lane))
        .first();
      if (
        existing?.workId &&
        (await pool.status(ctx, existing.workId as WorkId)).state !== "finished"
      )
        continue;
      if (existing && existing.retryAt > Date.now()) continue;
      const id =
        existing?._id ??
        (await ctx.db.insert("compaction_lanes", {
          lane,
          failures: 0,
          retryAt: 0,
        }));
      await enqueue(ctx, id);
    }
    const idleFailures = (
      await ctx.db.query("compaction_lanes").collect()
    ).filter((lane) => lane.failures > 0 && !lanes.includes(lane.lane));
    for (const lane of idleFailures)
      await ctx.db.patch("compaction_lanes", lane._id, {
        failures: 0,
        retryAt: 0,
        lastError: undefined,
      });
    return null;
  },
});

export const selectBatch = internalQuery({
  args: { lane: v.id("compaction_lanes") },
  returns: v.object({ ids: v.array(v.id("counter_logs")), more: v.boolean() }),
  handler: async (ctx, { lane }) => {
    const state = await ctx.db.get("compaction_lanes", lane);
    if (!state) throw new Error("Compaction lane missing");
    const ids: Id<"counter_logs">[] = [];
    let bytes = 0;
    const keys = new Set<string>();
    for await (const log of ctx.db
      .query("counter_logs")
      .withIndex("by_lane", (q) =>
        q.eq("lane", state.lane === -1 ? undefined : state.lane),
      )) {
      const size = getConvexSize(log);
      if (log.lane !== undefined) keys.add(log.key);
      // Deletion and snapshot writes also consume reads; reserve headroom below 4096.
      if (
        (ids.length + 1) * 2 + keys.size * 4 > COMPACTION_READ_BUDGET ||
        bytes + size > MAX_BATCH_BYTES
      )
        return { ids, more: true };
      ids.push(log._id);
      bytes += size;
    }
    return { ids, more: false };
  },
});

export const applyBatch = internalMutation({
  args: { ids: v.array(v.id("counter_logs")) },
  returns: v.number(),
  handler: async (ctx, { ids }) => {
    if (ids.length > MAX_COMPACTION_LOGS)
      throw new Error("Compaction batch too large");
    const logs = await Promise.all(
      [...new Set(ids)].map((id) => ctx.db.get("counter_logs", id)),
    );
    let processed = 0;
    const byKey = new Map<string, Array<NonNullable<(typeof logs)[number]>>>();
    for (const log of logs) {
      if (!log) continue;
      if (log.lane === undefined) {
        await ctx.db.patch("counter_logs", log._id, {
          lane: Math.floor(Math.random() * COMPACTION_LANES),
        });
        processed++;
        continue;
      }
      const key = `${log.lane}:${log.key}`;
      const group = byKey.get(key) ?? [];
      group.push(log);
      byKey.set(key, group);
    }
    if (logs.length * 2 + byKey.size * 4 > COMPACTION_READ_BUDGET)
      throw new Error("Compaction read budget exceeded");
    const counts = await Promise.all(
      Array.from(byKey.values(), async (group) => {
        const { key, lane } = group[0];
        const [reset, snapshot] = await Promise.all([
          ctx.db
            .query("compaction_leases")
            .withIndex("by_key_and_expires_at", (q) => q.eq("key", key))
            .first(),
          ctx.db
            .query("counter_snapshots")
            .withIndex("by_key_and_lane", (q) =>
              q.eq("key", key).eq("lane", lane),
            )
            .unique(),
        ]);
        if (reset) {
          const clearing =
            reset.clearBefore !== undefined ||
            !reset.job ||
            (
              await ctx.db.system.get("_scheduled_functions", reset.job)
            )?.name.endsWith(":clearKeyBatch");
          if (clearing) return 0;
        }
        const count =
          (snapshot?.count ?? 0) +
          group.reduce((sum, log) => sum + log.delta, 0);
        if (!Number.isFinite(count))
          throw new Error(`Counter overflow for ${key}`);
        if (snapshot)
          await ctx.db.patch("counter_snapshots", snapshot._id, { count });
        else await ctx.db.insert("counter_snapshots", { key, lane, count });
        await Promise.all(
          group.map((log) => ctx.db.delete("counter_logs", log._id)),
        );
        return group.length;
      }),
    );
    processed += counts.reduce((sum, count) => sum + count, 0);
    return processed;
  },
});

export const compact = internalAction({
  args: { lane: v.id("compaction_lanes") },
  returns: batchResult,
  handler: async (
    ctx,
    { lane },
  ): Promise<{ processed: number; more: boolean }> => {
    const { ids, more } = await ctx.runQuery(internal.maintenance.selectBatch, {
      lane,
    });
    const processed = ids.length
      ? await ctx.runMutation(internal.maintenance.applyBatch, { ids })
      : 0;
    return { processed, more };
  },
});

export const completed = internalMutation({
  args: vOnCompleteValidator(v.object({ lane: v.id("compaction_lanes") })),
  returns: v.null(),
  handler: async (ctx, { workId, context, result }) => {
    const lane = await ctx.db.get("compaction_lanes", context.lane);
    if (!lane || lane.workId !== workId) return null;
    const failures = result.kind === "success" ? 0 : lane.failures + 1;
    await ctx.db.patch("compaction_lanes", lane._id, {
      workId: undefined,
      failures,
      retryAt: failures
        ? Date.now() +
          Math.min(60000, POLL_INTERVAL_MS * 2 ** Math.min(failures - 1, 4))
        : 0,
      lastError: result.kind === "failed" ? result.error : undefined,
    });
    if (result.kind === "success") {
      const value = result.returnValue as { processed: number; more: boolean };
      if (value.more && value.processed > 0) await enqueue(ctx, lane._id);
    }
    return null;
  },
});

export const health = query({
  args: {},
  returns: v.object({
    maxParallelism: v.number(),
    pollIntervalMs: v.number(),
    oldestPendingDeltaAt: v.union(v.number(), v.null()),
    outstandingLanes: v.number(),
    failedLanes: v.number(),
  }),
  handler: async (ctx) => {
    const config = await ctx.db.query("compaction_config").first();
    const oldest = await Promise.all(
      Array.from({ length: COMPACTION_LANES + 1 }, (_, lane) =>
        firstPendingLog(ctx, lane === COMPACTION_LANES ? undefined : lane),
      ),
    );
    const pendingTimes = oldest.flatMap((log) =>
      log ? [log._creationTime] : [],
    );
    const lanes = await ctx.db.query("compaction_lanes").collect();
    return {
      maxParallelism: config?.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
      pollIntervalMs: config?.pollIntervalMs ?? POLL_INTERVAL_MS,
      oldestPendingDeltaAt: pendingTimes.length
        ? Math.min(...pendingTimes)
        : null,
      outstandingLanes: lanes.filter((lane) => lane.workId !== undefined)
        .length,
      failedLanes: lanes.filter((lane) => lane.failures > 0).length,
    };
  },
});
