import { defineApp } from "convex/server";
import conflictFreeCounter from "convex-conflict-free-counter/convex.config";

const app = defineApp();
app.use(conflictFreeCounter);

export default app;
