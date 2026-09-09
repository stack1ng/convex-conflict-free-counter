# Changelog

## 2.0.0

- Replace per-write compaction signals and per-key watchdog chains with a
  dedicated Workpool and fixed compaction lanes.
- Keep counter writes append-only, with no shared counter reads or scheduled
  jobs in business transactions.
- Add component-wide `configureCompaction` and `compactionHealth`; default to
  four concurrent jobs and five-second discovery. The old per-client delay and
  lease settings no longer configure compaction.
- Store snapshots per lane and sum legacy snapshots during upgrades. Do not
  downgrade to 1.x after new snapshots exist without a compatible reader or data
  migration.
- Preserve queued legacy entry points and reset boundaries, recover failed work,
  and reject non-finite totals.
- Add bounded-batch, recovery, migration, and real-backend load-test coverage.

## 1.0.2

- Release 1.0.2

## 1.0.1

- Release 1.0.1

## 1.0.0

- Release 1.0.0

## 0.1.0

- Initial release.
