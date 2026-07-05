# Conflict-free counter demo

A Next.js app that races the same parallel-increment workload against a
naive one-document counter and
[`convex-conflict-free-counter`](https://github.com/stack1ng/convex-conflict-free-counter).
Increments are fired as parallel HTTP mutations (independent transactions),
so contention on the naive counter is directly observable: Convex retries
conflicting mutations, and past its retry budget it rejects them outright.

Reference numbers against a local dev backend, 1,000 parallel increments:

| Mode          | Committed | Rejected (write conflicts) | Duration |
| ------------- | --------- | -------------------------- | -------- |
| Conflict-free | 1000/1000 | 0                          | ~1.3s    |
| Naive         | 845/1000  | 155                        | ~2.4s    |

Cloud deployments show a larger gap: higher per-commit latency widens the
conflict window.

## Run locally

From this directory:

```sh
npm install
npx convex dev          # terminal 1 — creates .env.local on first run
npm run dev             # terminal 2 — Next.js on http://localhost:3000
```

If `.env.local` only contains `CONVEX_URL`, add a
`NEXT_PUBLIC_CONVEX_URL` line with the same value.

## Deploy (Vercel)

1. Import the repo in Vercel and set **Root Directory** to `demo`.
2. Set the build command to `npx convex deploy --cmd 'npm run build'`.
3. Create a Convex production deployment (`npx convex deploy` once locally,
   or via the dashboard) and add its `CONVEX_DEPLOY_KEY` as a Vercel
   environment variable.

The `prebuild` script builds the component package from the repo root, so
the `file:..` dependency resolves without publishing to npm first.
