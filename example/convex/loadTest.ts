import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { components, internal } from "./_generated/api";

export const write = internalMutation({
  args: {
    run: v.string(),
    offset: v.number(),
    batch: v.number(),
    keys: v.number(),
    rollback: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { run, offset, batch, keys, rollback }) => {
    if (
      !Number.isInteger(batch) ||
      batch < 1 ||
      batch > 1000 ||
      !Number.isInteger(keys) ||
      keys < 1
    )
      throw new Error("Invalid load batch");
    await ctx.db.insert("events", { kind: run });
    await ctx.runMutation(components.conflictFreeCounter.public.addMany, {
      deltas: Array.from({ length: batch }, (_, i) => ({
        key: `${run}:${(offset + i) % keys}`,
        delta: 1,
      })),
    });
    if (rollback) throw new Error("Intentional transaction rollback");
    return null;
  },
});

export const receipts = internalQuery({
  args: { run: v.string() },
  returns: v.number(),
  handler: async (ctx, { run }) => {
    const rows = await ctx.db
      .query("events")
      .withIndex("by_kind", (q) => q.eq("kind", run))
      .take(10000);
    if (rows.length === 10000)
      throw new Error("Receipt validation limit exceeded");
    return rows.length;
  },
});

export const counts = internalQuery({
  args: { run: v.string(), offset: v.number(), keys: v.number() },
  returns: v.array(v.number()),
  handler: async (ctx, { run, offset, keys }) => {
    if (keys < 1 || keys > 100) throw new Error("Invalid read batch");
    return Promise.all(
      Array.from({ length: keys }, async (_, i) => {
        const result = await ctx.runQuery(
          components.conflictFreeCounter.public.read,
          { key: `${run}:${offset + i}`, logScanLimit: 0 },
        );
        return result.count;
      }),
    );
  },
});

export const scheduleProbe = internalMutation({
  args: { run: v.string() },
  returns: v.null(),
  handler: async (ctx, { run }) => {
    await ctx.scheduler.runAfter(0, internal.loadTest.probe, {
      run,
      submittedAt: Date.now(),
    });
    return null;
  },
});

export const probe = internalMutation({
  args: { run: v.string(), submittedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { run, submittedAt }) => {
    await ctx.db.insert("probes", { run, lagMs: Date.now() - submittedAt });
    return null;
  },
});

export const probeResults = internalQuery({
  args: { run: v.string() },
  returns: v.array(v.number()),
  handler: async (ctx, { run }) =>
    (
      await ctx.db
        .query("probes")
        .withIndex("by_run", (q) => q.eq("run", run))
        .take(10000)
    ).map((probe) => probe.lagMs),
});
