# Convex Conflict-Free Counter Component

[![npm version](https://badge.fury.io/js/convex-conflict-free-counter.svg)](https://badge.fury.io/js/convex-conflict-free-counter)
[![Convex Component](https://www.convex.dev/components/badge/convex-conflict-free-counter)](https://www.convex.dev/components/convex-conflict-free-counter)

<!-- START: Include on https://convex.dev/components -->

An eventually consistent counter for [Convex](https://convex.dev). Writes append
deltas without reading counter state, acquiring a lease, or scheduling work.
Concurrent increments therefore do not introduce shared counter dependencies
into the calling business mutations. Convex's deployment and transaction limits
still apply.

A dedicated child [Workpool](https://github.com/get-convex/workpool) compacts
the deltas. A component cron discovers work every five seconds; it does not
create one scheduled job per write or per key. Sixteen lanes spread writes,
including writes to the same hot counter. Each lane owns its snapshot for each
key, so compaction workers also avoid writing each other's snapshots.

Reads sum the snapshots and as much of the remaining log as their read budget
allows. `fullyConsistent: true` means every committed delta visible to that
query was included. A partial read is explicitly marked `false`; the count is
not clamped or substituted with zero. Non-finite input and overflowing totals
throw.

## Installation

```sh
bun add convex-conflict-free-counter
```

Install the component in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import conflictFreeCounter from "convex-conflict-free-counter/convex.config";

const app = defineApp();
app.use(conflictFreeCounter);
export default app;
```

Create a client in your application:

```ts
import { ConflictFreeCounter } from "convex-conflict-free-counter";
import { components } from "./_generated/api";

export const counter = new ConflictFreeCounter(components.conflictFreeCounter);
```

Maintenance starts automatically when the component is deployed. It requires no
application cron, per-write initialization, or shared application workpool.

## Writes and reads

From a mutation, counter writes participate in the caller's transaction:

```ts
await counter.add(ctx, "tasks:running");
await counter.add(ctx, "tasks:running", -1);
await counter.addMany(ctx, [
  { key: "events:purchase", delta: 1 },
  { key: "events:total", delta: 1 },
]);
```

Read from a query, mutation, or action:

```ts
const { count, fullyConsistent } = await counter.count(ctx, "tasks:running");
await counter.count(ctx, "tasks:running", { logScanLimit: 100 });
await counter.count(ctx, "tasks:running", { logScanLimit: 0 });
```

`logScanLimit: 0` reads only snapshots and conservatively returns
`fullyConsistent: false`, even when compaction has caught up. It reads up to 16
snapshot rows per key, plus one legacy snapshot during an upgrade. The default
reads additional logs within the transaction's remaining read budget. A log scan
creates reactive dependencies on those logs; snapshot-only subscriptions update
when compaction updates snapshots.

Do not interpret an incomplete or failed read as an authoritative zero. Scaling
and other safety-sensitive consumers must explicitly handle stale or missing
data.

## Compaction configuration

Defaults are four concurrent jobs and a five-second discovery interval. To
change them, call this once from an internal setup or administration mutation:

```ts
await counter.configureCompaction(ctx, {
  maxParallelism: 4,
  pollIntervalMs: 5_000,
});
```

Configuration is persisted per installed component, not per client instance.
`maxParallelism` must be an integer from 1 to 16. `pollIntervalMs` must be an
integer of at least 5,000; the five-second cron checks whether that interval has
elapsed. The interval controls discovery after a lane catches up. A lane with a
backlog continues at the back of the pool's queue without waiting for another
poll.

There is at most one outstanding work item per lane, plus one migration lane
while upgrading old logs. A batch uses a budget of 3,000 estimated reads,
including implicit reads performed by writes: roughly 1,498 deltas for one key
or 500 deltas for distinct keys, with a 2 MiB log-data cap. Applying a batch
reads the selected IDs, updates snapshots and deletes those deltas atomically.
Repeating an applied batch cannot double-count it.

Workpool retries failed actions three times with exponential backoff. Failed or
canceled lanes are eligible for rediscovery with backoff capped at one minute.
An old completion callback cannot overwrite a newer lane's work ID. Pending jobs
have no counter lease deadline that expires while they wait in the scheduler.

Workpool limits concurrency, not Convex's shared scheduler, database bandwidth,
or mutation capacity. A sustained arrival rate above compaction throughput still
creates a **data** backlog. Monitor freshness and tune the pool against the
actual deployment and workload; five seconds is a discovery interval, not a
freshness SLA. Separate application pools can allocate concurrency budgets to
task control, counters and other work, but do not provide reserved database
capacity.

Inspect freshness and maintenance failures:

```ts
const health = await counter.compactionHealth(ctx);
```

The result contains `maxParallelism`, `pollIntervalMs`, `oldestPendingDeltaAt`
(`null` when there are no uncompacted deltas), `outstandingLanes`, and
`failedLanes`. Compute age from `oldestPendingDeltaAt` at the observer so cached
query results do not freeze an age calculation. A failing lane retains its error
in the component's `compaction_lanes` table. Fix or reset an overflowing counter
rather than retrying it at a high rate.

Client options `compactionDelay` and `compactionLeaseDuration` remain accepted
for source compatibility but no longer control compaction. Use
`configureCompaction`. `defaultLogScanLimit` remains a client option:

```ts
const counter = new ConflictFreeCounter(components.conflictFreeCounter, {
  defaultLogScanLimit: 0,
});
```

## Buffering and reset

Coalesce repeated deltas inside one business mutation:

```ts
const buffered = counter.bindDeltasBuffer(ctx);
await counter.addBuffered(buffered, "tasks:running", 2);
await counter.addBuffered(buffered, "tasks:running", -1);
await counter.flushDeltas(buffered);
```

`reset(ctx, key)` removes all snapshots for the key and the first deletion batch
inline. A larger reset finishes asynchronously behind a reset fence. Later
deltas beyond the reset's creation-time boundary survive. Reads during a large
reset can observe a shrinking partial total; reset is not globally atomic across
batches. A second reset fences the previous continuation. Compaction never folds
data while its key's reset fence is present.

Counts use IEEE 754 doubles. Integer totals are exact only within JavaScript's
safe-integer range; fractional sums can differ in their last bits as batches and
lanes change addition order. These counters are unsuitable as a strict quota
lock or an exact decimal-money ledger.

## Upgrading

Existing snapshots remain part of the sum. Old logs without a lane are assigned
to lanes in bounded Workpool batches before compaction. Queued legacy compaction
and watchdog functions remain as no-ops, so they drain without spawning more
jobs. Legacy reset continuations retain their boundary and finish normally;
ordinary legacy leases are cleaned in bounded pages. No whole-table rewrite or
counter reset is required to install the update.

Do not downgrade to the old implementation after lane snapshots have been
created: the old reader understands only one snapshot per key. Rollback requires
a compatible reader or an explicit data migration.

## Tests

For application unit tests, the `/test` export registers this component and its
nested Workpool:

```ts
import { convexTest } from "convex-test";
import conflictFreeCounter from "convex-conflict-free-counter/test";

const t = convexTest(schema, modules);
conflictFreeCounter.register(t);
```

`convex-test` does not execute component crons automatically. Version 0.0.49
also does not implement the snapshot-query syscall used by Workpool's batch
worker. The package's behavioral tests explicitly adapt that syscall to a normal
query; that adapter **does not test isolation, OCC, or production scheduling**.
Those properties require a running backend. See
[the load-test guide](docs/load-testing.md) for the guarded harness, recovery
checks, and measured results.

<!-- END: Include on https://convex.dev/components -->

Run local checks with `bun run build`, `bun run test`, `bun run lint`, and
`bun run typecheck`. The example application is in `example/convex`.
