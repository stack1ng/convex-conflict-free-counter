import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { api, components } from "./_generated/api";
import { ConflictFreeCounter } from "convex-conflict-free-counter";
import { Id } from "./_generated/dataModel";

const conflictFreeCounter = new ConflictFreeCounter(
  components.conflictFreeCounter,
);

function getCounterKey(demo_run: Id<"demo_runs">) {
  return `demo-${demo_run}`;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("demo_runs").order("desc").collect();
  },
});

export const values = query({
  args: {
    demo_run: v.id("demo_runs"),
  },
  returns: v.object({
    naive: v.number(),
    conflictFree: v.number(),
    sharded: v.number(),
    fullyConsistent: v.boolean(),
  }),
  handler: async (ctx, { demo_run }) => {
    const naiveDoc = await ctx.db
      .query("naive_counters")
      .withIndex("by_demo_run", (q) => q.eq("demo_run", demo_run))
      .unique();
    const key = getCounterKey(demo_run);
    const cf = await conflictFreeCounter.count(ctx, key);
    const sharded = await ctx.runQuery(components.shardedCounter.public.count, {
      name: key,
    });
    return {
      naive: naiveDoc?.value ?? 0,
      conflictFree: cf.count,
      sharded,
      fullyConsistent: cf.fullyConsistent,
    };
  },
});

export const runDemoIncrements = mutation({
  args: {
    target_count: v.number(),
    shard_count: v.number(),
  },
  handler: async (ctx, { target_count, shard_count }) => {
    const demoRun = await ctx.db.insert("demo_runs", {
      target_count,
      shard_count,
    });
    const counter = await ctx.db.insert("naive_counters", {
      demo_run: demoRun,
      value: 0,
    });
    for (let i = 0; i < target_count; i++) {
      await ctx.scheduler.runAfter(0, api.counter.incrementNaive, {
        counter_id: counter,
      });
      await ctx.scheduler.runAfter(0, api.counter.incrementConflictFree, {
        demo_run: demoRun,
      });
      await ctx.scheduler.runAfter(0, api.counter.incrementSharded, {
        demo_run: demoRun,
      });
    }
  },
});

export const deleteDemoRun = internalMutation({
  args: {
    demo_run: v.id("demo_runs"),
  },
  handler: async (ctx, { demo_run }) => {
    await ctx.db.delete("demo_runs", demo_run);
  },
});

// Read-modify-write on a single document: concurrent increments conflict,
// get retried, and under enough parallelism exhaust their retries and are
// rejected with an OCC error.
export const incrementNaive = mutation({
  args: {
    counter_id: v.id("naive_counters"),
  },
  handler: async (ctx, { counter_id }) => {
    const doc = await ctx.db.get(counter_id);
    if (!doc) throw new Error("Counter not found");
    await ctx.db.patch("naive_counters", counter_id, { value: doc.value + 1 });
  },
});

// Append-only log write: concurrent increments never touch the same
// document, so they all commit in parallel on the first try.
export const incrementConflictFree = mutation({
  args: {
    demo_run: v.id("demo_runs"),
  },
  handler: async (ctx, { demo_run }) => {
    await conflictFreeCounter.add(ctx, getCounterKey(demo_run));
  },
});

// Random-shard read-modify-write: fewer conflicts than naive, but still
// contends when many increments hit the same shard.
export const incrementSharded = mutation({
  args: {
    demo_run: v.id("demo_runs"),
  },
  handler: async (ctx, { demo_run }) => {
    const run = await ctx.db.get(demo_run);
    if (!run) throw new Error("Demo run not found");
    await ctx.runMutation(components.shardedCounter.public.add, {
      name: getCounterKey(demo_run),
      count: 1,
      shards: run.shard_count,
    });
  },
});

