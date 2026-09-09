import type { QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import type { PaginationOptions, PaginationResult } from "convex/server";
import schema from "./schema.js";
import { paginator } from "convex-helpers/server/pagination";

// Conservative fallbacks for runtimes that don't expose transaction metrics
// (convex-test as of 0.0.41). Real deployments always report live headroom;
// these numbers stay far inside Convex's documented per-transaction limits.
const FALLBACK_DOCUMENTS_READ_REMAINING = 8_192;
const FALLBACK_BYTES_READ_REMAINING = 4 * 1024 * 1024;

export async function getReadHeadroom(
  ctx: QueryCtx,
): Promise<{ documentsRead: number; bytesRead: number }> {
  try {
    const metrics = await ctx.meta?.getTransactionMetrics?.();
    if (metrics) {
      return {
        documentsRead: metrics.documentsRead.remaining,
        bytesRead: metrics.bytesRead.remaining,
      };
    }
  } catch {
    // Fall through to the static fallback.
  }
  return {
    documentsRead: FALLBACK_DOCUMENTS_READ_REMAINING,
    bytesRead: FALLBACK_BYTES_READ_REMAINING,
  };
}

// computeDeltaFromLogs computes the delta for the readable page of logs.
// It reads as much as the given pagination options allow.
export async function computeDeltaFromLogs(
  ctx: QueryCtx,
  key: string,
  paginationOptions: PaginationOptions,
): Promise<{
  delta: number;
  paginationResult: PaginationResult<Doc<"counter_logs">>;
}> {
  const logs = await paginator(ctx.db, schema)
    .query("counter_logs")
    .withIndex("by_key", (q) => q.eq("key", key))
    .order("asc")
    .paginate(paginationOptions);

  return {
    delta: logs.page.reduce((acc, log) => acc + log.delta, 0),
    paginationResult: logs,
  };
}

export async function getSnapshot(
  ctx: QueryCtx,
  key: string,
): Promise<{ count: number }> {
  const snapshots = await ctx.db
    .query("counter_snapshots")
    .withIndex("by_key", (q) => q.eq("key", key))
    .take(COMPACTION_LANES + 1);
  const count = snapshots.reduce((sum, snapshot) => sum + snapshot.count, 0);
  if (!Number.isFinite(count)) throw new Error(`Counter overflow for ${key}`);
  return { count };
}

export const COMPACTION_LANES = 16;
export const COMPACTION_READ_BUDGET = 3000;
export const MAX_COMPACTION_LOGS = COMPACTION_READ_BUDGET / 2;
export const POLL_INTERVAL_MS = 5000;
export const DEFAULT_MAX_PARALLELISM = 4;

// Preserve index prefetching when reading past deleted log entries.
export async function firstPendingLog(
  ctx: QueryCtx,
  lane: number | undefined,
): Promise<Doc<"counter_logs"> | null> {
  for await (const log of ctx.db
    .query("counter_logs")
    .withIndex("by_lane", (q) => q.eq("lane", lane)))
    return log;
  return null;
}
