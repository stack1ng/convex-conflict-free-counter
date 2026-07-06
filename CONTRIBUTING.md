# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm run clean
npm run build
npm run typecheck
npm run lint
npm run test
```

## Building a one-off package

```sh
npm run clean
npm ci
npm pack
```

## Releasing

Releases are published **only** by CI when a `v*` tag is pushed, via npm
Trusted Publishing (no token). To cut one:

```sh
npm run release      # patch bump + push tag  → CI publishes
npm run alpha        # prerelease bump + push tag → CI publishes to "alpha"
```

See [PUBLISHING.md](PUBLISHING.md) for the full flow.
