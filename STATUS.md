# Status

**Last updated:** 2026-08-29

`convex-rn` is **experimental**. The GitHub repository is public so Expo EAS and other CI systems can install it from a git SHA without a private token — not because it is finished. It is not published to npm unless STATUS or the README says otherwise.

## Production readiness

| Question | Answer |
| --- | --- |
| Safe for production apps? | **No.** |
| API stable? | **No.** `0.x` may break without a migration guide. |
| Official Convex support? | **No.** Independent project. |
| SLA / support contract? | **None.** |

We will not publish `1.0.0` until we are willing to stand behind the API and the native install story.

## What we are testing

Currently exercised in real Expo / React Native apps:

- `useSyncQuery` / `useSyncQueryState` for selected list queries
- `performMutation` (id-based and upsert/`match`)
- `useSyncConnection` offline banner
- Lazy MMKV load so a JS reload on an old binary does not crash (memory fallback)

Not treated as tested or supported:

- Siri / App Intents / SwiftData search
- Gemini / App Functions / AppSearch
- Schema codegen (`docs/Codegen_Automation_Guide.md`)
- Sharing one `ConvexClient` with `convex/react` in every app
- Encryption, multi-user device profiles, or cache eviction policies
- Web

## Known sharp edges

- MMKV v4 requires `react-native-nitro-modules` in the **native** binary. EAS Update / Stallion cannot add it.
- Synced queries must return `Array<{ _id: string }>`.
- Queued mutations that fail for non-network reasons are discarded.
- Cache keys and MMKV store id (`convex-rn-sync-storage`) may change in `0.x`.

## How to read version numbers

- `0.2.x` — current experimental line. Prefer an exact pin (`convex-rn@0.2.1`).
- `0.3.0` and later — expect breaking changes.
- `1.0.0` — does not exist yet on purpose.
