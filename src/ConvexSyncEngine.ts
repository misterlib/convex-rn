import { useState, useEffect } from 'react';
import { syncStorage } from './Storage';
import NativeConvexBridge from './NativeConvexBridge';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';

// Dynamic load of NetInfo to remain safe in mock/headless environments
let NetInfo: any = null;
try {
  NetInfo = require('@react-native-community/netinfo');
} catch {
  // Graceful fallback
}

export interface DatabaseChange {
  type: 'insert' | 'update' | 'delete';
  table: string;
  id: string;
  indexableText?: string[];
  jsonData?: string;
  updatedAt?: number;
}

export interface DataDelta {
  sequenceNumber: number;
  timestamp: number;
  changes: DatabaseChange[];
}

export type IndexRuleFunction = (
  doc: any,
  getCachedItem: (table: string, id: string) => any
) => string[];

export interface SyncEngineOptions {
  backgroundMode?: boolean;
  schemaMap: Record<string, { table: string }>;
  indexRules?: Record<string, IndexRuleFunction>;
}

export interface QueuedMutation {
  queueId: string;
  tableName: string;
  mutationPath: string;
  docId: string;
  localFields: Record<string, any>;
  mutationArgs: Record<string, any>;
  timestamp: number;
}

interface ActiveQuerySubscription {
  queryPath: string;
  args: Record<string, any>;
  listeners: Set<() => void>;
  unsubscribe: () => void;
}

export class ConvexSyncEngine {
  private backgroundMode: boolean;
  private schemaMap: Record<string, { table: string }>;
  private indexRules: Record<string, IndexRuleFunction>;
  private sequenceNumber = 0;
  private isProcessingQueue = false;
  private isOnline = true;
  private convexClient: ConvexClient;
  private convexHttpClient: ConvexHttpClient;
  private unsubscribeConnection: (() => void) | null = null;

  // Track queries currently active/mounted in the UI
  private activeQueries = new Map<string, ActiveQuerySubscription>();

  constructor(convexUrl: string, options: SyncEngineOptions) {
    this.backgroundMode = options.backgroundMode ?? false;
    this.schemaMap = options.schemaMap;
    this.indexRules = options.indexRules ?? {};

    // Restore last sequence number from storage
    const seq = syncStorage.getItem('sync_seq_num');
    if (seq) {
      this.sequenceNumber = parseInt(seq, 10);
    }

    // Polyfill WebSocket in environments that do not have it defined (e.g. Node/Jest)
    if (typeof WebSocket === 'undefined') {
      (globalThis as any).WebSocket = class MockWebSocket {
        send() {}
        close() {}
      };
    }

    // Initialize Convex clients
    this.convexClient = new ConvexClient(convexUrl);
    this.convexHttpClient = new ConvexHttpClient(convexUrl);

    // Set up network connectivity change listener
    this.initializeConnectionListener();
  }

  /**
   * Listens to Convex WebSocket connection events to trigger flushes on network recovery.
   */
  private initializeConnectionListener() {
    console.log(
      '[ConvexSyncEngine] Initializing connection state listener. BackgroundMode:',
      this.backgroundMode
    );

    this.unsubscribeConnection = this.convexClient.subscribeToConnectionState(
      (state) => {
        const wasOffline = !this.isOnline;
        this.isOnline = state.isWebSocketConnected;

        if (this.isOnline && wasOffline) {
          console.log(
            '[ConvexSyncEngine] WebSocket connected to Convex server. Flushing mutations.'
          );
          this.processMutationQueue().catch((err) => {
            console.error(
              '[ConvexSyncEngine] Error flushing mutations on reconnect:',
              err
            );
          });
        }
      }
    );

    // Fallback/listen to NetInfo if available to aid connection detection
    if (NetInfo) {
      NetInfo.addEventListener((state: any) => {
        const netInfoOnline =
          (state.isConnected && (state.isInternetReachable ?? true)) ?? false;
        if (!netInfoOnline && this.isOnline) {
          this.isOnline = false;
          console.log('[ConvexSyncEngine] NetInfo indicates offline.');
        }
      });
    }
  }

  /**
   * Helper to retrieve a document from cache for relational indexing/joins
   */
  public getCachedItem = (table: string, id: string): any => {
    const cacheKey = `cache_table_${table}`;
    const cachedRaw = syncStorage.getItem(cacheKey);
    if (!cachedRaw) return null;
    try {
      const items: any[] = JSON.parse(cachedRaw);
      return items.find((item) => item._id === id) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Synchronous query retrieval for React Native UI
   */
  getCachedQueryResults(
    queryPath: string,
    args: Record<string, any> = {}
  ): any[] {
    const cacheKey = `query::${queryPath}::${JSON.stringify(args)}`;
    const cachedRaw = syncStorage.getItem(cacheKey);
    if (!cachedRaw) return [];
    try {
      return JSON.parse(cachedRaw);
    } catch {
      return [];
    }
  }

  /**
   * Registers a UI listener for a query and handles background synchronization.
   * Returns an unsubscribe function.
   */
  subscribeQuery(
    queryPath: string,
    args: Record<string, any> = {},
    onChange: () => void
  ): () => void {
    const key = `${queryPath}::${JSON.stringify(args)}`;
    let subscription = this.activeQueries.get(key);

    if (!subscription) {
      const unsubscribeWS = this.convexClient.onUpdate(
        queryPath as any,
        args,
        (freshData: any[]) =>
          this.handleQueryResultUpdate(queryPath, args, freshData).catch(
            (err) => {
              console.error(
                '[ConvexSyncEngine] Error handling query update:',
                err
              );
            }
          ),
        (err) => {
          console.error(
            `[ConvexSyncEngine] Subscription error for ${queryPath}:`,
            err
          );
        }
      );

      subscription = {
        queryPath,
        args,
        listeners: new Set<() => void>(),
        unsubscribe: unsubscribeWS,
      };
      this.activeQueries.set(key, subscription);
    }

    subscription.listeners.add(onChange);

    return () => {
      if (subscription) {
        subscription.listeners.delete(onChange);
        if (subscription.listeners.size === 0) {
          subscription.unsubscribe();
          this.activeQueries.delete(key);
        }
      }
    };
  }

  /**
   * Trigger callback notifies to React hooks
   */
  private notifyListeners(queryPath: string, args: Record<string, any>) {
    const key = `${queryPath}::${JSON.stringify(args)}`;
    const subscription = this.activeQueries.get(key);
    if (subscription) {
      for (const listener of subscription.listeners) {
        try {
          listener();
        } catch (e) {
          console.error(
            '[ConvexSyncEngine] Error executing query listener:',
            e
          );
        }
      }
    }
  }

  /**
   * Synchronizes a specific query parameter set.
   * Compares fresh query results with cached results, runs indexing, and pushes generic delta natively.
   */
  async syncQuery(
    queryPath: string,
    args: Record<string, any> = {}
  ): Promise<any[]> {
    let freshData: any[] = [];
    try {
      freshData = (await this.convexHttpClient.query(
        queryPath as any,
        args
      )) as any[];
    } catch (error) {
      console.error(
        `[ConvexSyncEngine] Failed to sync query '${queryPath}':`,
        error
      );
      throw error;
    }

    await this.handleQueryResultUpdate(queryPath, args, freshData);
    return freshData;
  }

  /**
   * Handles query result changes by diffing, updating local cache, and piping deltas to Native bridge.
   */
  private async handleQueryResultUpdate(
    queryPath: string,
    args: Record<string, any>,
    freshData: any[]
  ): Promise<void> {
    const mapping = this.schemaMap[queryPath];
    if (!mapping) {
      throw new Error(
        `[ConvexSyncEngine] No schema mapping registered for query path: ${queryPath}`
      );
    }
    const tableName = mapping.table;

    // Load old results of this specific query
    const cacheKey = `query::${queryPath}::${JSON.stringify(args)}`;
    const cachedRaw = syncStorage.getItem(cacheKey);
    const cachedData: any[] = cachedRaw ? JSON.parse(cachedRaw) : [];

    // Diff changes
    const cachedMap = new Map<string, any>(cachedData.map((t) => [t._id, t]));
    const freshMap = new Map<string, any>(freshData.map((t) => [t._id, t]));

    const changes: DatabaseChange[] = [];

    // Check for inserts and updates
    for (const freshDoc of freshData) {
      const cachedDoc = cachedMap.get(freshDoc._id);

      const isNew = !cachedDoc;
      const isChanged =
        cachedDoc && JSON.stringify(cachedDoc) !== JSON.stringify(freshDoc);

      if (isNew || isChanged) {
        // Run developer-defined index rules to get flat keywords for Siri/Spotlight
        let indexableText: string[] = [];
        const indexRule = this.indexRules[tableName];
        if (indexRule) {
          try {
            indexableText = indexRule(freshDoc, this.getCachedItem);
          } catch (e) {
            console.error(
              `[ConvexSyncEngine] Error executing index rule for table '${tableName}':`,
              e
            );
          }
        } else {
          // Fallback: extract all string values from the document object
          indexableText = Object.values(freshDoc).filter(
            (v) => typeof v === 'string'
          ) as string[];
        }

        changes.push({
          type: isNew ? 'insert' : 'update',
          table: tableName,
          id: freshDoc._id,
          indexableText,
          jsonData: JSON.stringify(freshDoc),
          updatedAt: freshDoc.updatedAt ?? Date.now(),
        });
      }
    }

    // Check for deletes
    for (const cachedDoc of cachedData) {
      if (!freshMap.has(cachedDoc._id)) {
        changes.push({
          type: 'delete',
          table: tableName,
          id: cachedDoc._id,
        });
      }
    }

    if (changes.length > 0) {
      this.sequenceNumber += 1;
      const delta: DataDelta = {
        sequenceNumber: this.sequenceNumber,
        timestamp: Date.now(),
        changes,
      };

      // Save query result cache
      syncStorage.setItem(cacheKey, JSON.stringify(freshData));

      // Also update the global table cache (so getCachedItem can do joins)
      const tableKey = `cache_table_${tableName}`;
      const globalRaw = syncStorage.getItem(tableKey);
      const globalData: any[] = globalRaw ? JSON.parse(globalRaw) : [];
      const globalList = this.mergeFreshIntoGlobal(
        globalData,
        freshData,
        changes
      );
      syncStorage.setItem(tableKey, JSON.stringify(globalList));

      syncStorage.setItem('sync_seq_num', this.sequenceNumber.toString());

      // Pipe structural delta across Native JSI Bridge
      await this.pipeDeltaToNative(delta);

      // Trigger re-renders in registered React hooks
      this.notifyListeners(queryPath, args);
    }
  }

  /**
   * Helper to merge fresh query results into the global table database
   */
  private mergeFreshIntoGlobal(
    globalData: any[],
    freshData: any[],
    changes: DatabaseChange[]
  ): any[] {
    const globalIds = new Map<string, any>(globalData.map((d) => [d._id, d]));

    for (const change of changes) {
      if (change.type === 'insert' || change.type === 'update') {
        const doc = freshData.find((d) => d._id === change.id);
        if (doc) {
          globalIds.set(change.id, doc);
        }
      } else if (change.type === 'delete') {
        globalIds.delete(change.id);
      }
    }
    return Array.from(globalIds.values());
  }

  /**
   * Performs local optimistic update, queues backend mutation in local storage,
   * updates native models, and attempts to send writes eventually.
   */
  async performMutation(
    tableName: string,
    mutationPath: string,
    id: string,
    localFields: Record<string, any>,
    mutationArgs: Record<string, any>
  ): Promise<void> {
    const tableKey = `cache_table_${tableName}`;
    const globalRaw = syncStorage.getItem(tableKey);
    const globalData: any[] = globalRaw ? JSON.parse(globalRaw) : [];

    let existingDoc = globalData.find((d) => d._id === id);
    let updatedDoc: any;

    if (existingDoc) {
      updatedDoc = { ...existingDoc, ...localFields, updatedAt: Date.now() };
    } else {
      updatedDoc = { _id: id, ...localFields, updatedAt: Date.now() };
    }

    // Merge back to global list
    const updatedGlobal = globalData.filter((d) => d._id !== id);
    updatedGlobal.push(updatedDoc);
    syncStorage.setItem(tableKey, JSON.stringify(updatedGlobal));

    // Get flat index text
    let indexableText: string[] = [];
    const indexRule = this.indexRules[tableName];
    if (indexRule) {
      indexableText = indexRule(updatedDoc, this.getCachedItem);
    } else {
      indexableText = Object.values(updatedDoc).filter(
        (v) => typeof v === 'string'
      ) as string[];
    }

    this.sequenceNumber += 1;
    syncStorage.setItem('sync_seq_num', this.sequenceNumber.toString());

    // Push optimistic update to Native bridge
    const delta: DataDelta = {
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      changes: [
        {
          type: existingDoc ? 'update' : 'insert',
          table: tableName,
          id,
          indexableText,
          jsonData: JSON.stringify(updatedDoc),
          updatedAt: Date.now(),
        },
      ],
    };
    await this.pipeDeltaToNative(delta);

    // Queue mutation to offline storage
    const queueId = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newMutation: QueuedMutation = {
      queueId,
      tableName,
      mutationPath,
      docId: id,
      localFields,
      mutationArgs,
      timestamp: Date.now(),
    };

    const queuedRaw = syncStorage.getItem('offline_mutations');
    const queue: QueuedMutation[] = queuedRaw ? JSON.parse(queuedRaw) : [];
    queue.push(newMutation);
    syncStorage.setItem('offline_mutations', JSON.stringify(queue));

    // Optimistically patch active query caches that map to this table, so the UI re-renders instantly
    for (const [_, subscription] of this.activeQueries.entries()) {
      const mapping = this.schemaMap[subscription.queryPath];
      if (mapping && mapping.table === tableName) {
        const queryCacheKey = `query::${subscription.queryPath}::${JSON.stringify(subscription.args)}`;
        const cachedRaw = syncStorage.getItem(queryCacheKey);
        if (cachedRaw) {
          try {
            const queryData: any[] = JSON.parse(cachedRaw);
            const index = queryData.findIndex((d) => d._id === id);
            if (index !== -1) {
              queryData[index] = { ...queryData[index], ...localFields };
              syncStorage.setItem(queryCacheKey, JSON.stringify(queryData));
              this.notifyListeners(subscription.queryPath, subscription.args);
            } else if (!existingDoc) {
              // Append new document to query results for instant optimistic insert
              queryData.push(updatedDoc);
              syncStorage.setItem(queryCacheKey, JSON.stringify(queryData));
              this.notifyListeners(subscription.queryPath, subscription.args);
            }
          } catch (e) {
            console.error(
              '[ConvexSyncEngine] Error updating query cache optimistically:',
              e
            );
          }
        }
      }
    }

    // Try processing queue immediately
    this.processMutationQueue();
  }

  /**
   * Processes the queue of mutations sequentially, keeping order (FIFO).
   */
  async processMutationQueue(): Promise<void> {
    if (this.isProcessingQueue) return;

    const queuedRaw = syncStorage.getItem('offline_mutations');
    if (!queuedRaw) return;

    let queue: QueuedMutation[] = JSON.parse(queuedRaw);
    if (queue.length === 0) return;

    this.isProcessingQueue = true;
    console.log(
      `[ConvexSyncEngine] Processing offline mutation queue (${queue.length} pending)`
    );

    while (queue.length > 0) {
      const activeMutation = queue[0];
      if (!activeMutation) break;

      try {
        await this.convexClient.mutation(
          activeMutation.mutationPath as any,
          activeMutation.mutationArgs
        );

        // Successfully sent: remove from queue
        console.log(
          `[ConvexSyncEngine] Successfully synced mutation ${activeMutation.mutationPath} (${activeMutation.queueId})`
        );
        queue.shift();
        syncStorage.setItem('offline_mutations', JSON.stringify(queue));
      } catch (error) {
        const errorStr = String(error);
        const isNetworkError =
          errorStr.includes('Network') ||
          errorStr.includes('fetch') ||
          errorStr.includes('WebSocket') ||
          errorStr.includes('timeout') ||
          errorStr.includes('Failed to send') ||
          errorStr.includes('closed');

        if (!isNetworkError) {
          // Validation error: discard to prevent blocking subsequent writes
          console.error(
            `[ConvexSyncEngine] Mutation failed (discarded):`,
            activeMutation,
            error
          );
          queue.shift();
          syncStorage.setItem('offline_mutations', JSON.stringify(queue));
          continue;
        }

        // Network timeout / server down: keep in queue to retry on reconnect
        console.warn(
          `[ConvexSyncEngine] Offline or server unreachable. Retrying mutation on reconnect. Error:`,
          error
        );
        break;
      }
    }

    this.isProcessingQueue = false;
  }

  private async pipeDeltaToNative(delta: DataDelta): Promise<void> {
    try {
      if (
        NativeConvexBridge &&
        typeof NativeConvexBridge.applyDelta === 'function'
      ) {
        await NativeConvexBridge.applyDelta(JSON.stringify(delta));
      } else {
        console.log(
          '[ConvexSyncEngine] Native JSI Bridge not available. Delta:',
          delta
        );
      }
    } catch (e) {
      console.error('[ConvexSyncEngine] Error piping delta:', e);
    }
  }

  /**
   * Closes the underlying Convex WebSocket client connection and cleans up listeners.
   */
  public close(): void {
    if (this.unsubscribeConnection) {
      this.unsubscribeConnection();
    }
    this.convexClient.close();
  }
}

/**
 * Custom React Hook that returns local cached values instantly (synchronously),
 * binds UI updates dynamically, and triggers auto-sync in the background.
 */
export function useSyncQuery<T = any>(
  syncEngine: ConvexSyncEngine,
  queryPath: string,
  args: Record<string, any> = {}
): T[] {
  const [data, setData] = useState<T[]>(() =>
    syncEngine.getCachedQueryResults(queryPath, args)
  );

  const serializedArgs = JSON.stringify(args);

  useEffect(() => {
    const parsedArgs = JSON.parse(serializedArgs);
    // Sync initial state
    setData(syncEngine.getCachedQueryResults(queryPath, parsedArgs));

    // Register active query listener. When sync finishes, this triggers a re-render
    const unsubscribe = syncEngine.subscribeQuery(queryPath, parsedArgs, () => {
      setData(syncEngine.getCachedQueryResults(queryPath, parsedArgs));
    });

    return unsubscribe;
  }, [syncEngine, queryPath, serializedArgs]);

  return data;
}
