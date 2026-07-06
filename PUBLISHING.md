# Publishing

Publishing happens **only** through CI, on a version tag, using npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). There
is no npm token anywhere — not in CI secrets, not on a maintainer's machine.
Pushing a `v*` tag is the one and only way a version reaches npm.

## Cutting a release

1. Bump the version and push the tag:

   ```sh
   npm run release       # patch bump: updates CHANGELOG, commits, tags
   # or  npm run alpha    # prerelease bump on the "alpha" dist-tag
   # or, for a minor/major bump:
   npm version minor && git push --follow-tags
   ```

   `npm version` runs the checks (`preversion`) and the CHANGELOG edit
   (`version`) locally, then creates the commit and tag. `npm run release` /
   `npm run alpha` also `git push --follow-tags` for you. None of these
   publish anything themselves.

2. The pushed `v*` tag triggers the
   [release workflow](.github/workflows/release.yml). Running in the
   `Production` environment, it re-runs the tests, typecheck, and lint,
   verifies the tag matches `package.json`, and runs `npm publish` —
   authenticating via OIDC with no token. npm attaches build provenance
   automatically. Prerelease versions publish to the `alpha` dist-tag.

Watch the run under the repo's Actions tab; the published version appears on
npm once it goes green.

## One-time setup (already configured)

- **npm** → package Settings → **Trusted Publisher**: GitHub repository
  `stack1ng/convex-conflict-free-counter`, workflow `release.yml`,
  environment `Production`.
- **GitHub** → repo → Settings → Environments → **Production**: deployment
  tag policy restricted to `v*`, so only tag releases can reach the trusted
  publisher.

There is intentionally **no `NPM_TOKEN` secret**. If one is ever added,
remove it — the OIDC flow does not use it, and a token is a credential worth
not having.

## Prerequisite for bumping locally

`npm version` (via `preversion`) runs `npx convex codegen`, which needs a
configured Convex dev deployment. On a fresh clone, run once:

```sh
npx convex dev --once   # an anonymous local deployment is fine
```

## Listing on the Convex components directory

Once a version is on npm with the public repo:

1. Optionally run the preflight checker:
   https://www.convex.dev/components/submit/check
2. Submit the component: https://www.convex.dev/components/submit
   (requires sign-in; you'll need the npm package URL and GitHub repo URL).
3. The Convex team reviews submissions on a rolling basis — typically within
   a few business days. Approved components appear on
   https://www.convex.dev/components with a "Community" badge.
