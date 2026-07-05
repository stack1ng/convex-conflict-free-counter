import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The "naive" counter: a single document whose value every increment
  // read-modify-writes, so concurrent increments conflict and serialize.
  naive_counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
});
