import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const logValidator = v.object({
  key: v.string(),
  delta: v.number(),
  lane: v.optional(v.number()),
});

export default defineSchema({
  // Writers only insert; maintenance never adds a dependency to their transactions.
  counter_logs: defineTable(logValidator)
    .index("by_key", ["key"])
    .index("by_lane", ["lane"]),

  // A snapshot per lane, plus an optional unsharded snapshot from older versions.
  counter_snapshots: defineTable({
    key: v.string(),
    count: v.number(),
    lane: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_key_and_lane", ["key", "lane"]),

  compaction_config: defineTable({
    maxParallelism: v.number(),
    pollIntervalMs: v.number(),
    lastPollAt: v.number(),
    leaseCursor: v.optional(v.union(v.string(), v.null())),
  }),
  compaction_lanes: defineTable({
    lane: v.number(),
    workId: v.optional(v.string()),
    failures: v.number(),
    retryAt: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_lane", ["lane"]),

  // Reset fences and leases retained for queued jobs from earlier versions.
  compaction_leases: defineTable({
    key: v.string(),
    expires_at: v.number(),
    job: v.optional(v.id("_scheduled_functions")),
    clearBefore: v.optional(v.number()),
  }).index("by_key_and_expires_at", ["key", "expires_at"]),
});
