import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  events: defineTable({
    kind: v.string(),
  }).index("by_kind", ["kind"]),
  probes: defineTable({ run: v.string(), lagMs: v.number() }).index("by_run", [
    "run",
  ]),
});
