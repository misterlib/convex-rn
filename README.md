# convex-rn

[![Status: experimental](https://img.shields.io/badge/status-experimental-orange)](./STATUS.md)
[![Not production-ready](https://img.shields.io/badge/production-not%20ready-red)](./STATUS.md)
[![Version 0.x](https://img.shields.io/badge/semver-0.x%20breaking%20OK-lightgrey)](./STATUS.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Opt-in offline cache and mutation queue for [Convex](https://www.convex.dev) apps on React Native / Expo.

> [!CAUTION]
> **Experimental software. Do not use this in production apps.**
>
> This is a first public release while the API and native stack are still being proven. `0.x` versions may change without a migration path. There is no stability guarantee, no SLA, and no promise that cached data or queued mutations will survive a version bump.
>
> If you need production offline sync today, do not adopt this package.

> [!WARNING]
> **Unofficial.** This is an independent project by [Kurt Libby](https://github.com/misterlib). It is **not** affiliated with, endorsed by, or supported by Convex (Convex, Inc.). “Convex” is a trademark of its owner.

Read [current status](./STATUS.md) before installing.

---

## What this is

A **progressive, opt-in** layer you add next to `convex/react`:

- Cache selected query results on device (MMKV when native modules are present).
- Render that cache on mount, then keep it fresh over the Convex WebSocket.
- Queue mutations while offline and flush them when the connection returns.
- Leave every other screen on normal `useQuery` / `useMutation`.

You do **not** replace your Convex client. You do **not** have to wrap the whole app.

## What this is not

- Not an official Convex product or a drop-in replacement for `convex/react`.
- Not a general-purpose local database or CRDT.
- Not production-ready (see [STATUS.md](./STATUS.md)).
- Not something Stallion / EAS Update / OTA can fully enable. MMKV v4 needs NitroModules in the **native binary**. A JS-only update will fall back to an in-memory cache and lose data on process death.

Siri / Gemini / App Intents indexing exists in this repo as an early experiment. It is **not** the supported path and is not what we are testing. See [docs/AI_Integration_Guide.md](./docs/AI_Integration_Guide.md) only if you are exploring that yourself.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| React Native New Architecture | TurboModules / Nitro must be enabled |
| `react-native-mmkv` v4 | Loads Nitro at import time |
| `react-native-nitro-modules` | Peer of MMKV v4 |
| `@react-native-community/netinfo` | Connection signals |
| `convex` ≥ 1.16 | Official JS client |
| iOS deployment target 17.0+ | Required by current native deps |
| A **native rebuild** | `npx expo run:ios` / `run:android` or EAS Build — not Metro reload alone |

Query functions you sync **must return an array of documents with `_id`**. Object / null / paginated shapes are not supported yet.

---

## Install

Pin an exact `0.x` version. Do not use `latest` or `*` in an app you care about.

```sh
npm install convex-rn@0.2.1 react-native-mmkv @react-native-community/netinfo react-native-nitro-modules
```

Expo iOS target (example):

```json
{
  "plugins": [
    ["expo-build-properties", { "ios": { "deploymentTarget": "17.0" } }]
  ]
}
```

Then rebuild the native app. If Nitro is missing, `convex-rn` will log a warning and use memory storage so the JS bundle does not crash — that is **not** offline persistence.

### EAS Build

A public GitHub repo is enough. Pin a commit SHA:

```json
"convex-rn": "github:misterlib/convex-rn#<commit-sha>"
```

EAS can clone public repositories without a `GITHUB_TOKEN`. npm publish is optional and not required.

---

## Quick start

### 1. Create one engine per app

Map only the Convex query paths you want cached to a local table name.

```ts
import { ConvexSyncEngine } from 'convex-rn';

export const syncEngine = new ConvexSyncEngine(
  process.env.EXPO_PUBLIC_CONVEX_URL!,
  {
    schemaMap: {
      'tasks:list': { table: 'tasks' },
      'events:list': { table: 'events' },
    },
  }
);
```

Optional: share an existing `ConvexClient` and forward auth so you do not open a second WebSocket:

```ts
const syncEngine = new ConvexSyncEngine(convexUrl, {
  schemaMap,
  client: existingConvexClient,
});

syncEngine.setAuth(async () => token);
```

### 2. Read with cache + live updates

```tsx
import { useSyncQuery, useSyncQueryState } from 'convex-rn';

function TaskList({ userId }: { userId: string | null }) {
  const tasks = useSyncQuery<Task>(
    syncEngine,
    'tasks:list',
    userId ? { creator: userId } : 'skip'
  );

  const { data, status } = useSyncQueryState<Task>(
    syncEngine,
    'tasks:list',
    userId ? { creator: userId } : 'skip'
  );
  // status: 'missing' | 'cache' | 'live'

  return null;
}
```

Paths accept a string (`"tasks:list"`) or a Convex `FunctionReference` (`api.tasks.list`).

### 3. Write with an optimistic local update

```ts
await syncEngine.performMutation(
  'tasks',
  'tasks:toggle',
  'task_abc123',
  { completed: true },
  { id: 'task_abc123' }
);

// Upsert when the client does not know the document id yet:
await syncEngine.performMutation({
  table: 'tasks',
  mutationPath: 'tasks:completeByTitle',
  match: (doc) => doc.title === title && doc.listId === listId,
  localFields: { completed: true },
  mutationArgs: { title, listId, completed: true },
});
```

Rejected mutations (validation, auth, etc.) are dropped from the queue. Subscribe if you need to undo UI:

```ts
syncEngine.onMutationRejected((mutation, error) => {
  // toast / revert optimistic fields
});
```

### 4. Connection banner

```tsx
import { useSyncConnection } from 'convex-rn';

function OfflineSyncBanner() {
  const { isOnline, queuedCount } = useSyncConnection(syncEngine);
  if (isOnline && queuedCount === 0) return null;
  return null; // render your own banner
}
```

---

## When to keep `useQuery`

Keep `convex/react` for anything that should not work offline: settings, admin tools, chats, one-off detail fetches, paginated search, and queries that do not return `Array<{ _id }>`.

Use `convex-rn` only for the lists and writes you have explicitly mapped in `schemaMap`.

---

## Limitations (current)

- **0.x breakage.** Field names, cache key formats, and hook signatures can change.
- **Array queries only.** Non-array results are logged and ignored.
- **Native rebuild required** for durable MMKV. OTA cannot ship Nitro.
- **Second WebSocket** unless you pass `{ client }` into the constructor.
- **No automatic conflict merge.** Server rejection discards that queued mutation.
- **Local cache is not encrypted** beyond what MMKV / the OS provide. Do not treat it as a vault for secrets.
- **Siri / Gemini / codegen** in `docs/` are prototypes, not a supported product surface.

---

## Versioning

| Version | Meaning |
| --- | --- |
| `0.x.y` | Experimental. Breaking changes allowed on minor bumps. |
| `1.0.0` | **Will not be published until this is actually production-ready.** Absence of 1.0 is intentional. |

See [STATUS.md](./STATUS.md) for what is currently tested.

---

## Security

Please report vulnerabilities privately. See [SECURITY.md](./SECURITY.md).

Do not open a public issue for a security problem.

---

## Contributing

This project is early. Small, well-tested PRs are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).

If you are evaluating the library, open a discussion rather than assuming the API is stable.

---

## License

[MIT](./LICENSE) — provided **as is**, without warranty. That includes fitness for production use.

Convex, the Convex logo, and related marks are trademarks of Convex, Inc. See [NOTICE](./NOTICE.md).
