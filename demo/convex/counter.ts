import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { components } from "./_generated/api";
import { ConflictFreeCounter } from "convex-conflict-free-counter";

const counter = new ConflictFreeCounter(components.conflictFreeCounter);

const NAIVE_NAME = "demo";
const CF_KEY = "demo";

async function getNaiveDoc(ctx: QueryCtx) {
  return await ctx.db
    .query("naive_counters")
    .withIndex("by_name", (q) => q.eq("name", NAIVE_NAME))
    .unique();
}

export const values = query({
  args: {},
  returns: v.object({
    naive: v.number(),
    conflictFree: v.number(),
    fullyConsistent: v.boolean(),
  }),
  handler: async (ctx) => {
    const naiveDoc = await getNaiveDoc(ctx);
    const cf = await counter.count(ctx, CF_KEY);
    return {
      naive: naiveDoc?.value ?? 0,
      conflictFree: cf.count,
      fullyConsistent: cf.fullyConsistent,
    };
  },
});

// The demo fires many of these in parallel over HTTP (each request is an
// independent transaction, unlike mutations from one websocket session,
// which execute in order).

// Read-modify-write on a single document: concurrent increments conflict,
// get retried, and under enough parallelism exhaust their retries and are
// rejected with an OCC error.
export const incrementNaive = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const doc = await getNaiveDoc(ctx);
    if (doc) {
      await ctx.db.patch("naive_counters", doc._id, { value: doc.value + 1 });
    } else {
      await ctx.db.insert("naive_counters", { name: NAIVE_NAME, value: 1 });
    }
    return null;
  },
});

// Append-only log write: concurrent increments never touch the same
// document, so they all commit in parallel on the first try.
export const incrementConflictFree = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await counter.add(ctx, CF_KEY);
    return null;
  },
});

export const reset = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const doc = await getNaiveDoc(ctx);
    if (doc) await ctx.db.delete("naive_counters", doc._id);
    await counter.reset(ctx, CF_KEY);
    return null;
  },
});
