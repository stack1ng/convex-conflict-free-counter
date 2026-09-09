import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";
import { POLL_INTERVAL_MS } from "./shared.js";

const crons = cronJobs();
crons.interval(
  "discover pending counter deltas",
  { seconds: POLL_INTERVAL_MS / 1000 },
  internal.maintenance.poll,
  {},
);
export default crons;
