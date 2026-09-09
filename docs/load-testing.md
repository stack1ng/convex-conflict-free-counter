# Compaction validation

This change replaces per-write compaction signals and per-key lease/watchdog
chains with a component-owned Workpool. Business writes only append deltas. A
five-second cron discovers a fixed set of sixteen lanes; each lane can have one
outstanding work item. Legacy logs temporarily add a seventeenth migration lane.

The default pool parallelism is four. Pending lanes are durable database state;
Workpool owns dispatch, retries, and completion. Selecting delta IDs happens in
a query, then a mutation reads exactly those IDs, updates lane snapshots, and
deletes the deltas in one transaction. Reset fences are checked in the same
transaction. This avoids a mutation reading a growing log index range while
writers append to it.

## Reproducing the tests

Use Bun and a separate Convex **development** project. Do not deploy the example
load functions to an application that contains real data. Use a temporary copy
of this checkout so Convex CLI environment-file updates cannot change your
normal deployment selection.

Run the local checks:

```sh
bun install
bun run build
bun run test
bun run lint
bun run typecheck
```

`bun run test` runs Vitest followed by TypeScript checking of the test files.
The compaction tests enable `convex-test` transaction-limit checking. They also
adapt Workpool's unsupported `snapshotQuery` syscall to an ordinary query **only
in the test runtime**. These tests establish behavior, not real OCC, snapshot
isolation, cron dispatch, network latency, or deployment capacity.

In the temporary checkout, create/select an isolated dev deployment and deploy
`example/convex` with `bun x convex dev --once`. Obtain that deployment's admin
key through your own Convex account. Store a private JSON file outside the
repository:

```json
{
  "deploymentName": "YOUR_ISOLATED_DEV_DEPLOYMENT",
  "deploymentType": "dev",
  "url": "https://YOUR_ISOLATED_DEV_DEPLOYMENT.convex.cloud",
  "adminKey": "YOUR_PRIVATE_DEV_ADMIN_KEY"
}
```

Set its permissions to `0600`. Collect successful and failed function logs in a
separate terminal, using that same temporary checkout/deployment:

```sh
bun x convex logs --success --jsonl --history 0 > /tmp/counter-lab-functions.jsonl
```

Run one scenario at a time, allowing the previous run to drain:

```sh
COUNTER_LAB_CREDENTIALS=/private/path/counter-dev-credentials.json \
COUNTER_LAB_CONFIRM=YOUR_ISOLATED_DEV_DEPLOYMENT \
COUNTER_LAB_LOG=/tmp/counter-lab-functions.jsonl \
COUNTER_LAB_RESULT=/tmp/counter-hot-result.json \
bun scripts/load-test.mjs hot
```

The harness refuses credentials not marked `dev`, requires explicit
deployment-name confirmation, and writes only synthetic run-prefixed keys. It
does not retry failed business writes. It checks transaction receipts, compares
every final snapshot against accepted input, samples compaction health, and
schedules unrelated probes. A run fails on any business/observer error, a
30-minute drain timeout, missing receipt, or incorrect final count. The timeout
is a test stop condition, not a freshness target. Function logs separately
expose OCC, retries, and failures.

Available workloads:

| Scenario    |    Deltas | Distinct keys | Batch |         Concurrent requests |
| ----------- | --------: | ------------: | ----: | --------------------------: |
| smoke       |     1,000 |            20 |    10 |                           4 |
| smallUnique |     5,000 |         5,000 |    10 |                          32 |
| hot         |   200,000 |             1 |   100 |                         128 |
| broad       |   200,000 |        10,000 |   100 |                          64 |
| million     | 1,000,000 |        50,000 |   500 |                          64 |
| concurrency |   200,000 |         4,096 |   100 |                         256 |
| steady      |   120,000 |            64 |   100 | 16, paced at 2,000 deltas/s |
| sustained   |   480,000 |         4,096 |   100 | 32, paced at 4,000 deltas/s |

## Failure and upgrade coverage

Behavioral tests cover no scheduling or shared-state reads in the write path,
coalesced discovery, bounded batches by size/read cost, continuation fairness,
randomized count correctness, partial reads, overflow, replayed batches, reset
races, ten-minute dispatch delays, cancellation, retries, legacy logs/snapshots,
old queued entry points, and recovery of a canceled reset continuation.

Live backend checks additionally cover:

- Concurrent requests with successful and failed function logs, including OCC.
- A forced process kill with queued work, followed by restart after more than
  two minutes and exact verification of all accepted increments.
- A business transaction that writes a receipt and counter deltas, then throws:
  neither the receipt nor the deltas may commit.
- A reset spanning several deletion batches followed by new increments: only
  increments after the cutoff may remain.
- A large backlog that initially encountered compaction errors, then recovered
  without another write after deploying the correction.

The native backend uses its own loopback ports and storage. Its SQLite
persistence has different performance characteristics from hosted Convex. Use it
for lifecycle and transactional checks, not as a cloud throughput estimate.

## What the bounds do and do not guarantee

The number of outstanding counter work items is independent of writes, keys,
partitions, and task count. Four jobs by default does not mean four total
scheduled function invocations: Workpool also schedules its coordinator, worker
batches, completion, retries, and housekeeping. Those invocations grow with
completed batches; they are no longer created for every input change or key.

That bound applies to regular compaction. Large explicit resets retain their
bounded scheduled deletion continuations, and old scheduled jobs must drain
during an upgrade. A mass reset operation is not admission-controlled by this
Workpool.

Pending delta rows can still accumulate if input exceeds compaction throughput.
High key cardinality costs more than a hot counter because it requires more
snapshot writes. Each active key can acquire up to sixteen snapshots; reads sum
those rows plus a legacy base snapshot. The five-second interval is discovery
cadence, **not a five-second freshness guarantee**.

Separate pools prevent unrelated workflows from occupying counter pool slots.
They do not reserve Convex database throughput, action/mutation capacity, or
scheduler priority. Size all pools together and monitor `compactionHealth`,
Convex scheduler lag, function errors, and actual metric freshness. Increasing
pool parallelism can increase coordinator contention and resource competition.

This patch does not alter Synth's allocator deadlines, task reconciler, DLQ
acknowledgement paths, telemetry validation, or production configuration. Those
remain separate incident follow-ups. Do not downgrade to the old reader after
lane snapshots exist; it cannot correctly read the new representation.

## Validation summary

Hosted development runs verified 525,000 updates across hot-counter,
many-counter, and steady-input workloads, with up to 256 concurrent clients.
Every final count and receipt matched, with zero business-mutation failures or
retries. The compactor stayed within four active workers and sixteen outstanding
lanes. The largest tested burst took about 205 seconds to drain, while unrelated
scheduler probes remained below 4.4 seconds in those isolated runs. These are
measurements on one development deployment class, not a production capacity SLA.

A separate recovery experiment verified every counter after one million accepted
updates and compaction failures. Native-backend tests also verified process
restart with 50,000 queued updates, atomic rollback, multi-batch reset
boundaries, and upgrade with old jobs pending. Workpool coordinator OCC retries
and skipped cron invocations can still occur under load; the tests distinguish
these from business-mutation contention and verify eventual recovery.
