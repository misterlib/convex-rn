# React Native Convex Sync (convex-rn)

`convex-rn` is an independent, open-source local-first persistence engine for React Native applications syncing with Convex. It shifts the Convex React Native integration from a simple UI-bound query client to a decoupled database-backed local synchronization engine, supporting cross-process headless execution for system-level AI assistants.

With this library, Siri (via iOS App Intents & SwiftData) and Gemini (via Android AppFunctions & AppSearch) can query and access user data headlessly in the background without needing to boot the React Native UI or the JS Bridge runtime.

> [!WARNING]
> **Disclaimer**: This is an independent open-source project. It is **not** affiliated with, endorsed by, or associated with Convex (Convex, Inc.).

---

## Key Features

*   **Real-Time WebSocket Sync**: Connects to Convex via persistent WebSockets, subscribing to queries using the official Convex JS engine. Pushes server-side data changes in real-time, eliminating the need for query polling.
*   **Event-Driven Connection Recovery**: Automatically monitors connection state. The instant the WebSocket reconnects after being offline, it automatically flushes the queue of pending offline mutations.
*   **TypeScript Single Source of Truth**: Unified synchronization logic, conflict resolution, version control, and optimistic updates handled entirely in TypeScript.
*   **Decoupled Local Cache**: A high-performance synchronous local database (backed by `react-native-mmkv`) that caches query parameter sets reactively, rendering instantly from cache on mount.
*   **Generic Database Representation**: Rather than compiling app-specific tables in native code, the native bridges manage a schema-less, highly indexable document model.
*   **JS-Defined Indexing & Denormalization**: Developers define custom index text extraction rules in JavaScript during synchronization, allowing relational joins to be flattened and prepared for AI assistants before writing to disk.
*   **Off-Thread Performance**: Native modules offload all database write operations and system searches to background threads (Swift cooperative Task pool on iOS, custom ExecutorService on Android) to keep the React Native UI thread fully responsive.

## Coexistence & Progressive Adoption

`convex-rn` is designed as a **progressive, opt-in** library. **You do NOT need to replace your standard Convex queries.**

*   **When to keep standard queries (`useQuery` from `convex/react`)**: For standard, connection-reliant features (like settings pages, admin dashboards, or real-time chats) that do not need to work offline or be searchable by Siri/Gemini. Keep these unchanged.
*   **When to use `useSyncQuery` from `convex-rn`**: For core features (like lists, notes, or tasks) where you want local-first caching (instant rendering on mount), offline writing/queueing, and native indexing so system-level AI assistants can query your data headlessly.

This selective caching approach prevents device database bloat, saves bandwidth, and eliminates the risk of introducing offline complexities to non-critical parts of your application.

---

## Getting Started

### Installation

Install the library along with its peer dependencies:

```sh
npm install convex-rn react-native-mmkv @react-native-community/netinfo convex
```

*Note: For iOS SwiftData support, ensure your app targets iOS 17+ and has App Groups enabled. For Android AppSearch/AppFunctions support, configure the Kotlin Symbolic Processing (KSP) plugin in your gradle files.*

### Initialization

Define your query schema mappings and indexable text rules when instantiating the sync engine in React Native:

```typescript
import { ConvexSyncEngine } from 'convex-rn';

const syncEngine = new ConvexSyncEngine('https://your-convex-deployment.convex.cloud', {
  schemaMap: {
    // Map Convex query paths to local table names
    "tasks:list": { table: "tasks" },
    "events:list": { table: "events" },
    "users:list": { table: "users" }
  },
  indexRules: {
    // Flat text keywords indexed for Siri and Gemini search queries
    tasks: (doc) => [doc.title, doc.completed ? "completed" : "pending"],
    events: (doc, getCachedItem) => {
      // Easily denormalize relational data (e.g. user names) in TypeScript!
      const attendeeNames = doc.attendeeIds
        .map(userId => getCachedItem('users', userId)?.name)
        .filter(Boolean);
        
      return [doc.title, ...attendeeNames];
    }
  }
});
```

### Querying Data

Use the `useSyncQuery` hook inside your components to retrieve cached data synchronously on mount, establish a WebSocket-based real-time query subscription, and auto-update the UI when data changes:

```typescript
import { useSyncQuery } from 'convex-rn';

function TaskList() {
  // 1. Synchronously renders the cached list from local storage on mount
  // 2. Auto-subscribes to Convex WebSocket updates in the background
  // 3. Auto-updates UI and native AI indices when query data changes on the server
  const tasks = useSyncQuery<Task>(syncEngine, 'tasks:list', { creator: userId });

  return (
    // Render list...
  );
}
```

If you need to query or refresh data outside of a React hook context (e.g. in a background task), you can query manually or check the cache:

```typescript
// Synchronous manual check of MMKV cache
const cachedTasks = syncEngine.getCachedQueryResults('tasks:list', { creator: userId });

// Asynchronous query fetch (HTTP fallback/background execution)
const freshTasks = await syncEngine.syncQuery('tasks:list', { creator: userId });
```

### Optimistic Mutations

Apply local optimistic updates instantly and sync mutations asynchronously:

```typescript
await syncEngine.performMutation(
  'tasks',                // Table name
  'tasks:toggle',         // Mutation path
  'task_abc123',          // Document ID
  { completed: true },    // Local optimistic fields
  { id: 'task_abc123' }   // Mutation arguments sent to server
);
```

---

## AI Assistant Integration (Siri & Gemini)

For detailed information on configuring off-thread execution, understanding denormalization pitfalls, and setting up coding templates for custom assistant intents, see the [AI Integration Guide](./docs/AI_Integration_Guide.md).

### Out-of-the-Box Generic Search
The library automatically indexes your `indexableText` array and exposes generic search capabilities:
- **iOS**: Conforms to standard Siri search scopes using the generic `SearchConvexIntent` `@AssistantIntent`.
- **Android**: Registers `searchConvexData` as a Jetpack `@AppFunction` for Gemini.

### Custom App-Level Intents
To support specialized queries (e.g. *"When was the last time Erin was at an event?"*), app developers declare custom intents inside their application codebase. Because the library registers the generic SwiftData `ModelContainer` globally, your custom intent can fetch the container and resolve data instantly:

```swift
// Inside your main iOS app target
public struct GetLastEventForAttendeeIntent: AppIntent {
    @Parameter(title: "Attendee Name") var attendeeName: String
    
    // Injected by our convex-rn library during boot
    @Dependency private var modelContainer: ModelContainer

    public func perform() async throws -> some IntentResult {
        let context = ModelContext(modelContainer)
        // Query generic ConvexEntities where table == "events" and indexableText contains attendeeName...
    }
}
```

---

## Schema Synchronization & Codegen Automation

To keep your mobile app's local data structures, Siri `AppEntities`, and Gemini `AppSearch` schemas in perfect alignment with your Convex backend schema (`convex/schema.ts`) automatically, you can implement code generation.

We have compiled a complete automation blueprint in our [Codegen Automation Guide](./docs/Codegen_Automation_Guide.md), containing:
*   A **Node.js AST parser script** that reads `convex/schema.ts` and outputs generated Swift, Kotlin, and TypeScript mapping files.
*   **Developer Lifecycle Hooks** to trigger compilation automatically during `npx convex dev`, VSCode file saves, and git commits.

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) for more details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
