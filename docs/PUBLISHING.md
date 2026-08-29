# Publishing (maintainer)

A **public GitHub repo is enough**. Apps and EAS can install with:

```json
"convex-rn": "github:misterlib/convex-rn#<commit-sha>"
```

No `GITHUB_TOKEN` is required once the repository is public. npm is optional and is **not** required for EAS.

Do not treat “public on GitHub” or “published on npm” as “production-ready.” Stay on `0.x` until [STATUS.md](../STATUS.md) says otherwise.

## Before the repo is public

1. Search the tree for secrets: `.env`, tokens, keystores, `credentials.json`, private keys, Convex deploy keys.
2. Confirm `LICENSE`, `README.md`, `STATUS.md`, `NOTICE.md`, and `SECURITY.md` are accurate.
3. Confirm `package.json` `version` is `0.x.y` (never `1.0.0` by accident).
4. Run `yarn test`, `yarn typecheck`, and `yarn lint`.

## Make the GitHub repo public

```sh
gh repo edit misterlib/convex-rn --visibility public --accept-visibility-change-consequences
gh repo edit misterlib/convex-rn \
  --description "EXPERIMENTAL (not for production). Unofficial offline cache + mutation queue for Convex on React Native." \
  --homepage "https://github.com/misterlib/convex-rn#readme"
```

Suggested topics: `experimental`, `react-native`, `convex`, `expo`, `offline`, `unofficial`.

## Optional: first npm publish

Skip this until you explicitly want the registry. The name `convex-rn` was unused on the registry as of 2026-08-29.

1. Create an npm account and enable **2FA**.
2. `npm login`
3. From the repo root (after `yarn prepare` / `bob build`):

```sh
npm publish --access public
```

Pin apps to that exact version (`convex-rn@0.2.1`), not `latest`.

Optional later: [npm provenance](https://docs.npmjs.com/generating-provenance-statements) from GitHub Actions (`npm publish --provenance`). Do not set the repo `NPM_TOKEN` secret until you are ready for the release-please workflow to publish on merge.

## What not to do

- Do not publish `1.0.0` to “look finished.”
- Do not use `npm deprecate` unless you are withdrawing a broken release.
- Do not rename to a scoped package after people depend on `convex-rn` unless you are willing to publish both names.
- Do not describe this as an official Convex library in the npm description, README, or GitHub About.

## After the repo is public

Consuming apps can keep the git pin (`github:misterlib/convex-rn#<sha>`). EAS no longer needs `GITHUB_TOKEN` for this dependency. Only switch to `"convex-rn": "0.2.1"` if you later publish to npm.
