import { defineApp } from "convex/server";
import conflictFreeCounter from "convex-conflict-free-counter/convex.config";
import shardedCounter from "@convex-dev/sharded-counter/convex.config.js";

const app = defineApp();
app.use(conflictFreeCounter);
app.use(shardedCounter);

export default app;
