import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { clearKeyHandler } from "./compaction.js";
import {
  computeDeltaFromLogs,
  getReadHeadroom,
  getSnapshot,
  COMPACTION_LANES,
} from "./shared.js";

export const DEFAULT_COMPACTION_DELAY_MS = 15_000;
export const DEFAULT_COMPACTION_LEASE_DURATION_MS = 60_000;

// Conservative per-document size estimate used to keep unbounded log scans
// inside the transaction's byte budget (the convex-helpers paginator does not
// enforce byte limits itself). Assumes keys stay well under ~1 KiB.
const CONSERVATIVE_LOG_DOC_BYTES = 1_024;

const configArgs = {
  compactionDelay: v.optional(v.number()),
  compactionLeaseDuration: v.optional(v.number()),
};

function resolveConfig(args: {
  compactionDelay?: number;
  compactionLeaseDuration?: number;
}) {
  return {
    compactionDelay: args.compactionDelay ?? DEFAULT_COMPACTION_DELAY_MS,
    compactionLeaseDuration:
      args.compactionLeaseDuration ?? DEFAULT_COMPACTION_LEASE_DURATION_MS,
  };
}

// A NaN or Infinity delta would permanently poison the snapshot (NaN + x is
// NaN forever), so reject non-finite deltas at the boundary.
function assertFiniteDelta(delta: number) {
  if (!Number.isFinite(delta))
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `delta must be a finite number, got ${delta}`,
    });
}

export const add = mutation({
  args: {
    key: v.string(),
    delta: v.number(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (ctx, { key, delta }) => {
    assertFiniteDelta(delta);
    await ctx.db.insert("counter_logs", {
      key,
      delta,
      lane: Math.floor(Math.random() * COMPACTION_LANES),
    });
    return null;
  },
});

export const addMany = mutation({
  args: {
    // Note: Convex caps array arguments at 8,192 elements; the client class
    // chunks larger batches across calls.
    deltas: v.array(
      v.object({
        key: v.string(),
        delta: v.number(),
      }),
    ),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (ctx, { deltas }) => {
    if (deltas.length === 0) return null;

    for (const entry of deltas) {
      assertFiniteDelta(entry.delta);
      await ctx.db.insert("counter_logs", {
        ...entry,
        lane: Math.floor(Math.random() * COMPACTION_LANES),
      });
    }
    return null;
  },
});

export const read = query({
  args: {
    key: v.string(),
    // Max uncompacted log rows to scan on top of the snapshot. A
    // non-negative row count: 0 means snapshot-only, and omitting it scans
    // as much as the transaction's read budget allows. (Kept as v.number()
    // — the idiomatic count validator — rather than v.int64(), which would
    // force bigint through the client API; it is normalized to a
    // non-negative integer below.)
    logScanLimit: v.optional(v.number()),
  },
  returns: v.object({
    count: v.number(),
    fullyConsistent: v.boolean(),
  }),
  handler: async (ctx, { key, logScanLimit }) => {
    const latestSnapshot = await getSnapshot(ctx, key);

    // Treat logScanLimit as a non-negative integer so a negative or
    // fractional value can't skew the Math.min / pagination below (a
    // negative would otherwise force a snapshot-only read; a fraction would
    // reach paginate's numItems).
    const requestedScanLimit =
      logScanLimit === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(logScanLimit));

    // Scan as many uncompacted logs as the caller allows and the
    // transaction's remaining read headroom permits.
    const headroom = await getReadHeadroom(ctx);
    const scanRowsLimit = Math.min(
      headroom.documentsRead,
      Math.floor(headroom.bytesRead / CONSERVATIVE_LOG_DOC_BYTES),
      requestedScanLimit,
    );
    // Snapshot-only read: paginate rejects numItems < 1.
    if (scanRowsLimit < 1) {
      return {
        count: latestSnapshot.count,
        fullyConsistent: false,
      };
    }
    const { delta, paginationResult } = await computeDeltaFromLogs(ctx, key, {
      numItems: scanRowsLimit,
      maximumRowsRead: scanRowsLimit,
      cursor: null,
    });
    const count = latestSnapshot.count + delta;
    if (!Number.isFinite(count)) throw new Error(`Counter overflow for ${key}`);
    return {
      count,
      // Conservative: when the number of pending logs exactly equals the
      // scan limit, every delta was counted but isDone is still false.
      fullyConsistent: paginationResult.isDone,
    };
  },
});

// Large resets finish in bounded continuations; writes after the cutoff survive.
export const reset = mutation({
  args: {
    key: v.string(),
    ...configArgs,
  },
  returns: v.null(),
  handler: async (ctx, { key, ...config }) => {
    await clearKeyHandler(ctx, { key, ...resolveConfig(config) });
    return null;
  },
});
