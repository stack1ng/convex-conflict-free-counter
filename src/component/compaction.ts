import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import { COMPACTION_LANES, MAX_COMPACTION_LOGS } from "./shared.js";
import { internal } from "./_generated/api.js";

export const RESET_BATCH_SIZE = MAX_COMPACTION_LOGS;
const configArgs = {
  compactionDelay: v.number(),
  compactionLeaseDuration: v.number(),
};
const keyArgs = { key: v.string(), ...configArgs };
const leaseArgs = { ...keyArgs, lease: v.id("compaction_leases") };

// Retain entry points until jobs queued by earlier versions have drained.
export const signalNeedCompaction = internalMutation({
  args: keyArgs,
  returns: v.null(),
  handler: async () => null,
});
export const signalNeedCompactionMany = internalMutation({
  args: { keys: v.array(v.string()), ...configArgs },
  returns: v.null(),
  handler: async () => null,
});
export const watchdogLease = internalMutation({
  args: leaseArgs,
  returns: v.null(),
  handler: async () => null,
});
export const watchdogLeases = internalMutation({
  args: { leases: v.array(v.id("compaction_leases")), ...configArgs },
  returns: v.null(),
  handler: async () => null,
});
export const startCompactionMany = internalMutation({
  args: { leases: v.array(v.id("compaction_leases")), ...configArgs },
  returns: v.null(),
  handler: async () => null,
});
export const compactLogs = internalAction({
  args: leaseArgs,
  returns: v.null(),
  handler: async () => null,
});
export const compactLogSet = internalMutation({
  args: { ...leaseArgs, pageSize: v.number(), moreLogsExist: v.boolean() },
  returns: v.null(),
  handler: async () => null,
});
export const releaseLeaseAndRecheck = internalMutation({
  args: leaseArgs,
  returns: v.null(),
  handler: async () => null,
});
export const getCompactLogSet = internalQuery({
  args: {
    key: v.string(),
    numItems: v.number(),
    lease: v.optional(v.id("compaction_leases")),
  },
  returns: v.object({ pageSize: v.number(), isDone: v.boolean() }),
  handler: async () => ({ pageSize: 0, isDone: true }),
});

async function deleteLogsUpToBoundary(
  ctx: MutationCtx,
  key: string,
  boundaryCreationTime: number,
): Promise<{ moreRemain: boolean }> {
  const page = await ctx.db
    .query("counter_logs")
    .withIndex("by_key", (q) =>
      q.eq("key", key).lte("_creationTime", boundaryCreationTime),
    )
    .take(RESET_BATCH_SIZE);
  for (const log of page) {
    await ctx.db.delete("counter_logs", log._id);
  }
  return { moreRemain: page.length === RESET_BATCH_SIZE };
}

export async function clearKeyHandler(
  ctx: MutationCtx,
  {
    key,
    compactionDelay,
    compactionLeaseDuration,
  }: { key: string; compactionDelay: number; compactionLeaseDuration: number },
) {
  const leases = await ctx.db
    .query("compaction_leases")
    .withIndex("by_key_and_expires_at", (q) => q.eq("key", key))
    .take(64);
  for (const lease of leases) {
    await ctx.db.delete("compaction_leases", lease._id);
  }

  const snapshots = await ctx.db
    .query("counter_snapshots")
    .withIndex("by_key", (q) => q.eq("key", key))
    .take(COMPACTION_LANES + 1);
  await Promise.all(
    snapshots.map((snapshot) =>
      ctx.db.delete("counter_snapshots", snapshot._id),
    ),
  );

  const newestLog = await ctx.db
    .query("counter_logs")
    .withIndex("by_key", (q) => q.eq("key", key))
    .order("desc")
    .first();
  if (!newestLog) return;

  const { moreRemain } = await deleteLogsUpToBoundary(
    ctx,
    key,
    newestLog._creationTime,
  );
  if (!moreRemain) return;

  const clearLease = await ctx.db.insert("compaction_leases", {
    key,
    expires_at: Date.now() + compactionLeaseDuration,
    clearBefore: newestLog._creationTime,
  });
  const job = await ctx.scheduler.runAfter(
    0,
    internal.compaction.clearKeyBatch,
    {
      key,
      lease: clearLease,
      boundaryCreationTime: newestLog._creationTime,
      compactionDelay,
      compactionLeaseDuration,
    },
  );
  await ctx.db.patch("compaction_leases", clearLease, { job });
}

export const clearKeyBatch = internalMutation({
  args: {
    key: v.string(),
    lease: v.id("compaction_leases"),
    boundaryCreationTime: v.number(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (
    ctx,
    {
      key,
      lease,
      boundaryCreationTime,
      compactionDelay,
      compactionLeaseDuration,
    },
  ) => {
    if (!(await ctx.db.get("compaction_leases", lease))) return null;
    const { moreRemain } = await deleteLogsUpToBoundary(
      ctx,
      key,
      boundaryCreationTime,
    );
    if (moreRemain) {
      const job = await ctx.scheduler.runAfter(
        0,
        internal.compaction.clearKeyBatch,
        {
          key,
          lease,
          boundaryCreationTime,
          compactionDelay,
          compactionLeaseDuration,
        },
      );
      await ctx.db.patch("compaction_leases", lease, { job });
      return null;
    }
    await ctx.db.delete("compaction_leases", lease);
    return null;
  },
});
