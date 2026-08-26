import { useState, useEffect } from 'react';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { syncStorage } from './Storage';
import NativeConvexBridge from './NativeConvexBridge';
import {
  canonicalizeArgs,
  documentCacheKey,
  legacyQueryCacheKey,
  queryCacheKey,
  tableDocKey,
  tableIdsKey,
  tableLegacyKey,
} from './cacheKeys';
import { resolveFunctionPath, type FunctionPath } from './functionPath';

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

export type SyncQueryStatus = 'missing' | 'cache' | 'live';

export interface SyncQueryState<T = any> {
  data: T[];
  status: SyncQueryStatus;
}

export interface PerformMutationOptions {
  table: string;
  mutationPath: FunctionPath;
  docId?: string;
  match?: (doc: any) => boolean;
  localFields: Record<string, any>;
  mutationArgs: Record<string, any>;
}

export type MutationRejectedListener = (
  mutation: QueuedMutation,
  error: unknown
) => void;

export interface SyncEngineOptions {
  backgroundMode?: boolean;
  schemaMap: Record<string, { table: string }>;
  indexRules?: Record<string, IndexRuleFunction>;
  /** Share an existing ConvexClient instead of opening a second WebSocket. */
  client?: ConvexClient;
  httpClient?: ConvexHttpClient;
  onMutationRejected?: MutationRejectedListener;
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
  private ownsClient: boolean;
  private unsubscribeConnection: (() => void) | null = null;
  private unsubscribeNetInfo: (() => void) | null = null;

  private activeQueries = new Map<string, ActiveQuerySubscription>();
  private liveQueryKeys = new Set<string>();
  private connectionListeners = new Set<(isOnline: boolean) => void>();
  private queueListeners = new Set<(count: number) => void>();
  private mutationRejectedListeners = new Set<MutationRejectedListener>();

  constructor(convexUrl: string, options: SyncEngineOptions) {
    this.backgroundMode = options.backgroundMode ?? false;
    this.schemaMap = options.schemaMap;
    this.indexRules = options.indexRules ?? {};

    const seq = syncStorage.getItem('sync_seq_num');
    if (seq) {
      this.sequenceNumber = parseInt(seq, 10);
    }

    if (typeof WebSocket === 'undefined') {
      (globalThis as any).WebSocket = class MockWebSocket {
        send() {}
        close() {}
      };
    }

    if (options.client) {
      this.convexClient = options.client;
      this.ownsClient = false;
    } else {
      this.convexClient = new ConvexClient(convexUrl);
      this.ownsClient = true;
    }
    this.convexHttpClient =
      options.httpClient ?? new ConvexHttpClient(convexUrl);

    if (options.onMutationRejected) {
      this.mutationRejectedListeners.add(options.onMutationRejected);
    }

    this.initializeConnectionListener();
  }

  /**
   * Forward a Convex auth token fetcher to both the WebSocket and HTTP clients.
   */
  public setAuth(
    fetchToken: (args: {
      forceRefreshToken: boolean;
    }) => Promise<string | null | undefined>
  ): void {
    this.convexClient.setAuth(fetchToken);
    if (typeof this.convexHttpClient.setAuth === 'function') {
      this.convexHttpClient.setAuth(fetchToken as any);
    }
  }

  public getIsOnline(): boolean {
    return this.isOnline;
  }

  public getQueuedMutationCount(): number {
    return this.readMutationQueue().length;
  }

  public subscribeConnectionState(
    listener: (isOnline: boolean) => void
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.isOnline);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  public subscribeQueue(listener: (count: number) => void): () => void {
    this.queueListeners.add(listener);
    listener(this.getQueuedMutationCount());
    return () => {
      this.queueListeners.delete(listener);
    };
  }

  public onMutationRejected(listener: MutationRejectedListener): () => void {
    this.mutationRejectedListeners.add(listener);
    return () => {
      this.mutationRejectedListeners.delete(listener);
    };
  }

  private notifyConnectionListeners() {
    for (const listener of this.connectionListeners) {
      try {
        listener(this.isOnline);
      } catch (e) {
        console.error(
          '[ConvexSyncEngine] Error executing connection listener:',
          e
        );
      }
    }
  }

  private notifyQueueListeners() {
    const count = this.getQueuedMutationCount();
    for (const listener of this.queueListeners) {
      try {
        listener(count);
      } catch (e) {
        console.error('[ConvexSyncEngine] Error executing queue listener:', e);
      }
    }
  }

  private emitMutationRejected(mutation: QueuedMutation, error: unknown) {
    for (const listener of this.mutationRejectedListeners) {
      try {
        listener(mutation, error);
      } catch (e) {
        console.error(
          '[ConvexSyncEngine] Error executing mutation-rejected listener:',
          e
        );
      }
    }
  }

  private initializeConnectionListener() {
    console.log(
      '[ConvexSyncEngine] Initializing connection state listener. BackgroundMode:',
      this.backgroundMode
    );

    this.unsubscribeConnection = this.convexClient.subscribeToConnectionState(
      (state) => {
        const wasOffline = !this.isOnline;
        this.isOnline = state.isWebSocketConnected;
        this.notifyConnectionListeners();

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

    if (NetInfo) {
      this.unsubscribeNetInfo = NetInfo.addEventListener((state: any) => {
        const netInfoOnline =
          (state.isConnected && (state.isInternetReachable ?? true)) ?? false;
        if (!netInfoOnline && this.isOnline) {
          this.isOnline = false;
          this.notifyConnectionListeners();
          console.log('[ConvexSyncEngine] NetInfo indicates offline.');
        }
      });
    }
  }

  public getCachedItem = (table: string, id: string): any => {
    this.migrateLegacyTableIfNeeded(table);
    const cachedRaw = syncStorage.getItem(tableDocKey(table, id));
    if (!cachedRaw) return null;
    try {
      return JSON.parse(cachedRaw);
    } catch {
      return null;
    }
  };

  private getTableIds(table: string): string[] {
    const raw = syncStorage.getItem(tableIdsKey(table));
    if (!raw) return [];
    try {
      const ids = JSON.parse(raw);
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  private setTableIds(table: string, ids: string[]) {
    syncStorage.setItem(tableIdsKey(table), JSON.stringify(ids));
  }

  private migrateLegacyTableIfNeeded(table: string) {
    const legacyRaw = syncStorage.getItem(tableLegacyKey(table));
    if (!legacyRaw) return;
    try {
      const items: any[] = JSON.parse(legacyRaw);
      if (!Array.isArray(items)) {
        syncStorage.removeItem(tableLegacyKey(table));
        return;
      }
      const ids = new Set(this.getTableIds(table));
      for (const item of items) {
        if (item && typeof item._id === 'string') {
          syncStorage.setItem(
            tableDocKey(table, item._id),
            JSON.stringify(item)
          );
          ids.add(item._id);
        }
      }
      this.setTableIds(table, Array.from(ids));
      syncStorage.removeItem(tableLegacyKey(table));
    } catch {
      // Leave the legacy blob; next write will overwrite.
    }
  }

  private getTableDocs(table: string): any[] {
    this.migrateLegacyTableIfNeeded(table);
    const docs: any[] = [];
    for (const id of this.getTableIds(table)) {
      const doc = this.getCachedItem(table, id);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  private upsertTableDoc(table: string, doc: any) {
    if (!doc || typeof doc._id !== 'string') return;
    this.migrateLegacyTableIfNeeded(table);
    syncStorage.setItem(tableDocKey(table, doc._id), JSON.stringify(doc));
    const ids = this.getTableIds(table);
    if (!ids.includes(doc._id)) {
      ids.push(doc._id);
      this.setTableIds(table, ids);
    }
  }

  private deleteTableDoc(table: string, id: string) {
    this.migrateLegacyTableIfNeeded(table);
    syncStorage.removeItem(tableDocKey(table, id));
    this.setTableIds(
      table,
      this.getTableIds(table).filter((existing) => existing !== id)
    );
  }

  private readQueryCache(
    queryPath: string,
    args: Record<string, any> = {}
  ): any[] | null {
    const canonical = queryCacheKey(queryPath, args);
    let cachedRaw = syncStorage.getItem(canonical);
    if (!cachedRaw) {
      const legacy = legacyQueryCacheKey(queryPath, args);
      if (legacy !== canonical) {
        cachedRaw = syncStorage.getItem(legacy);
        if (cachedRaw) {
          syncStorage.setItem(canonical, cachedRaw);
          syncStorage.removeItem(legacy);
        }
      }
    }
    if (!cachedRaw) return null;
    try {
      const parsed = JSON.parse(cachedRaw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeQueryCache(
    queryPath: string,
    args: Record<string, any>,
    data: any[]
  ) {
    syncStorage.setItem(queryCacheKey(queryPath, args), JSON.stringify(data));
  }

  public hasCachedQuery(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): boolean {
    return this.readQueryCache(resolveFunctionPath(queryPath), args) !== null;
  }

  public isQueryLive(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): boolean {
    const path = resolveFunctionPath(queryPath);
    return this.liveQueryKeys.has(`${path}::${canonicalizeArgs(args)}`);
  }

  /**
   * Synchronous query retrieval for React Native UI.
   */
  getCachedQueryResults(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): any[] {
    return this.readQueryCache(resolveFunctionPath(queryPath), args) ?? [];
  }

  public getCachedDocument(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): any | null {
    const path = resolveFunctionPath(queryPath);
    const raw = syncStorage.getItem(documentCacheKey(path, args));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  public hasCachedDocument(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): boolean {
    const path = resolveFunctionPath(queryPath);
    return syncStorage.getItem(documentCacheKey(path, args)) !== null;
  }

  /**
   * Registers a UI listener for a query and handles background synchronization.
   * Returns an unsubscribe function.
   */
  subscribeQuery(
    queryPath: FunctionPath,
    args: Record<string, any> = {},
    onChange: () => void
  ): () => void {
    const path = resolveFunctionPath(queryPath);
    const key = `${path}::${canonicalizeArgs(args)}`;
    let subscription = this.activeQueries.get(key);

    if (!subscription) {
      const unsubscribeWS = this.convexClient.onUpdate(
        path as any,
        args,
        (freshData: any) =>
          this.handleQueryResultUpdate(path, args, freshData).catch((err) => {
            console.error(
              '[ConvexSyncEngine] Error handling query update:',
              err
            );
          }),
        (err) => {
          console.error(
            `[ConvexSyncEngine] Subscription error for ${path}:`,
            err
          );
        }
      );

      subscription = {
        queryPath: path,
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
   * Subscribe to a single-document query (`getById` style).
   */
  subscribeDocument(
    queryPath: FunctionPath,
    args: Record<string, any> = {},
    onChange: () => void
  ): () => void {
    const path = resolveFunctionPath(queryPath);
    const key = `doc::${path}::${canonicalizeArgs(args)}`;
    let subscription = this.activeQueries.get(key);

    if (!subscription) {
      const unsubscribeWS = this.convexClient.onUpdate(
        path as any,
        args,
        (freshData: any) =>
          this.handleDocumentResultUpdate(path, args, freshData).catch(
            (err) => {
              console.error(
                '[ConvexSyncEngine] Error handling document update:',
                err
              );
            }
          ),
        (err) => {
          console.error(
            `[ConvexSyncEngine] Document subscription error for ${path}:`,
            err
          );
        }
      );

      subscription = {
        queryPath: path,
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

  private notifyListeners(
    queryPath: string,
    args: Record<string, any>,
    kind: 'query' | 'document' = 'query'
  ) {
    const key =
      kind === 'document'
        ? `doc::${queryPath}::${canonicalizeArgs(args)}`
        : `${queryPath}::${canonicalizeArgs(args)}`;
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
   */
  async syncQuery(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): Promise<any[]> {
    const path = resolveFunctionPath(queryPath);
    let freshData: any;
    try {
      freshData = await this.convexHttpClient.query(path as any, args);
    } catch (error) {
      console.error(
        `[ConvexSyncEngine] Failed to sync query '${path}':`,
        error
      );
      throw error;
    }

    await this.handleQueryResultUpdate(path, args, freshData);
    return Array.isArray(freshData) ? freshData : [];
  }

  async syncDocument(
    queryPath: FunctionPath,
    args: Record<string, any> = {}
  ): Promise<any | null> {
    const path = resolveFunctionPath(queryPath);
    let freshData: any;
    try {
      freshData = await this.convexHttpClient.query(path as any, args);
    } catch (error) {
      console.error(
        `[ConvexSyncEngine] Failed to sync document '${path}':`,
        error
      );
      throw error;
    }
    await this.handleDocumentResultUpdate(path, args, freshData);
    return freshData ?? null;
  }

  private markQueryLive(queryPath: string, args: Record<string, any>) {
    this.liveQueryKeys.add(`${queryPath}::${canonicalizeArgs(args)}`);
  }

  /**
   * Handles query result changes by diffing, updating local cache, and piping deltas to Native bridge.
   */
  private async handleQueryResultUpdate(
    queryPath: string,
    args: Record<string, any>,
    freshData: any
  ): Promise<void> {
    if (!Array.isArray(freshData)) {
      console.error(
        `[ConvexSyncEngine] Query '${queryPath}' must return an array of documents with _id. Got:`,
        freshData === null ? 'null' : typeof freshData
      );
      this.markQueryLive(queryPath, args);
      this.notifyListeners(queryPath, args);
      return;
    }

    const mapping = this.schemaMap[queryPath];
    if (!mapping) {
      throw new Error(
        `[ConvexSyncEngine] No schema mapping registered for query path: ${queryPath}`
      );
    }
    const tableName = mapping.table;

    const cachedData = this.readQueryCache(queryPath, args) ?? [];

    const cachedMap = new Map<string, any>(
      cachedData
        .filter((t) => t && typeof t._id === 'string')
        .map((t) => [t._id, t])
    );
    const freshMap = new Map<string, any>(
      freshData
        .filter((t) => t && typeof t._id === 'string')
        .map((t) => [t._id, t])
    );

    const changes: DatabaseChange[] = [];

    for (const freshDoc of freshData) {
      if (!freshDoc || typeof freshDoc._id !== 'string') continue;
      const cachedDoc = cachedMap.get(freshDoc._id);

      const isNew = !cachedDoc;
      const isChanged =
        cachedDoc && JSON.stringify(cachedDoc) !== JSON.stringify(freshDoc);

      if (isNew || isChanged) {
        changes.push({
          type: isNew ? 'insert' : 'update',
          table: tableName,
          id: freshDoc._id,
          indexableText: this.buildIndexableText(tableName, freshDoc),
          jsonData: JSON.stringify(freshDoc),
          updatedAt: freshDoc.updatedAt ?? Date.now(),
        });
      }
    }

    for (const cachedDoc of cachedData) {
      if (cachedDoc?._id && !freshMap.has(cachedDoc._id)) {
        changes.push({
          type: 'delete',
          table: tableName,
          id: cachedDoc._id,
        });
      }
    }

    this.writeQueryCache(queryPath, args, freshData);

    if (changes.length > 0) {
      this.sequenceNumber += 1;
      const delta: DataDelta = {
        sequenceNumber: this.sequenceNumber,
        timestamp: Date.now(),
        changes,
      };

      for (const change of changes) {
        if (change.type === 'delete') {
          this.deleteTableDoc(tableName, change.id);
        } else {
          const doc = freshMap.get(change.id);
          if (doc) this.upsertTableDoc(tableName, doc);
        }
      }

      syncStorage.setItem('sync_seq_num', this.sequenceNumber.toString());
      await this.pipeDeltaToNative(delta);
    }

    this.markQueryLive(queryPath, args);
    this.notifyListeners(queryPath, args);
  }

  private async handleDocumentResultUpdate(
    queryPath: string,
    args: Record<string, any>,
    freshData: any
  ): Promise<void> {
    syncStorage.setItem(
      documentCacheKey(queryPath, args),
      JSON.stringify(freshData ?? null)
    );

    const mapping = this.schemaMap[queryPath];
    if (mapping && freshData && typeof freshData._id === 'string') {
      this.upsertTableDoc(mapping.table, freshData);
      this.sequenceNumber += 1;
      syncStorage.setItem('sync_seq_num', this.sequenceNumber.toString());
      await this.pipeDeltaToNative({
        sequenceNumber: this.sequenceNumber,
        timestamp: Date.now(),
        changes: [
          {
            type: 'update',
            table: mapping.table,
            id: freshData._id,
            indexableText: this.buildIndexableText(mapping.table, freshData),
            jsonData: JSON.stringify(freshData),
            updatedAt: freshData.updatedAt ?? Date.now(),
          },
        ],
      });
    }

    this.markQueryLive(queryPath, args);
    this.notifyListeners(queryPath, args, 'document');
  }

  private buildIndexableText(tableName: string, doc: any): string[] {
    const indexRule = this.indexRules[tableName];
    if (indexRule) {
      try {
        return indexRule(doc, this.getCachedItem);
      } catch (e) {
        console.error(
          `[ConvexSyncEngine] Error executing index rule for table '${tableName}':`,
          e
        );
        return [];
      }
    }
    return Object.values(doc).filter((v) => typeof v === 'string') as string[];
  }

  /**
   * Existing 5-arg form (table, path, docId, localFields, mutationArgs).
   * Also accepts a single options object for upserts without a known docId.
   */
  async performMutation(
    tableNameOrOptions: string | PerformMutationOptions,
    mutationPath?: FunctionPath,
    id?: string,
    localFields?: Record<string, any>,
    mutationArgs?: Record<string, any>
  ): Promise<void> {
    const options: PerformMutationOptions =
      typeof tableNameOrOptions === 'string'
        ? {
            table: tableNameOrOptions,
            mutationPath: mutationPath as FunctionPath,
            docId: id,
            localFields: localFields ?? {},
            mutationArgs: mutationArgs ?? {},
          }
        : tableNameOrOptions;

    const tableName = options.table;
    const resolvedPath = resolveFunctionPath(options.mutationPath);
    this.migrateLegacyTableIfNeeded(tableName);

    let existingDoc: any = null;
    if (options.docId) {
      existingDoc = this.getCachedItem(tableName, options.docId);
    } else if (options.match) {
      existingDoc = this.getTableDocs(tableName).find(options.match) ?? null;
    }

    const docId =
      options.docId ??
      existingDoc?._id ??
      `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const updatedDoc = existingDoc
      ? {
          ...existingDoc,
          ...options.localFields,
          _id: docId,
          updatedAt: Date.now(),
        }
      : { _id: docId, ...options.localFields, updatedAt: Date.now() };

    this.upsertTableDoc(tableName, updatedDoc);

    const indexableText = this.buildIndexableText(tableName, updatedDoc);

    this.sequenceNumber += 1;
    syncStorage.setItem('sync_seq_num', this.sequenceNumber.toString());

    await this.pipeDeltaToNative({
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      changes: [
        {
          type: existingDoc ? 'update' : 'insert',
          table: tableName,
          id: docId,
          indexableText,
          jsonData: JSON.stringify(updatedDoc),
          updatedAt: Date.now(),
        },
      ],
    });

    const queueId = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newMutation: QueuedMutation = {
      queueId,
      tableName,
      mutationPath: resolvedPath,
      docId,
      localFields: options.localFields,
      mutationArgs: options.mutationArgs,
      timestamp: Date.now(),
    };

    const queue = this.readMutationQueue();
    queue.push(newMutation);
    this.writeMutationQueue(queue);

    for (const [, subscription] of this.activeQueries.entries()) {
      const mapping = this.schemaMap[subscription.queryPath];
      if (mapping && mapping.table === tableName) {
        const queryData = this.readQueryCache(
          subscription.queryPath,
          subscription.args
        );
        if (queryData) {
          try {
            const index = queryData.findIndex((d) => d._id === docId);
            if (index !== -1) {
              queryData[index] = {
                ...queryData[index],
                ...options.localFields,
              };
              this.writeQueryCache(
                subscription.queryPath,
                subscription.args,
                queryData
              );
              this.notifyListeners(subscription.queryPath, subscription.args);
            } else if (!existingDoc) {
              queryData.push(updatedDoc);
              this.writeQueryCache(
                subscription.queryPath,
                subscription.args,
                queryData
              );
              this.notifyListeners(subscription.queryPath, subscription.args);
            } else if (options.match && options.match(updatedDoc)) {
              const matchIndex = queryData.findIndex(options.match);
              if (matchIndex !== -1) {
                queryData[matchIndex] = {
                  ...queryData[matchIndex],
                  ...options.localFields,
                };
              } else {
                queryData.push(updatedDoc);
              }
              this.writeQueryCache(
                subscription.queryPath,
                subscription.args,
                queryData
              );
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

    this.processMutationQueue();
  }

  private readMutationQueue(): QueuedMutation[] {
    const queuedRaw = syncStorage.getItem('offline_mutations');
    if (!queuedRaw) return [];
    try {
      const parsed = JSON.parse(queuedRaw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeMutationQueue(queue: QueuedMutation[]) {
    syncStorage.setItem('offline_mutations', JSON.stringify(queue));
    this.notifyQueueListeners();
  }

  /**
   * Processes the queue of mutations sequentially, keeping order (FIFO).
   */
  async processMutationQueue(): Promise<void> {
    if (this.isProcessingQueue) return;

    let queue = this.readMutationQueue();
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

        console.log(
          `[ConvexSyncEngine] Successfully synced mutation ${activeMutation.mutationPath} (${activeMutation.queueId})`
        );
        queue.shift();
        this.writeMutationQueue(queue);
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
          console.error(
            `[ConvexSyncEngine] Mutation failed (discarded):`,
            activeMutation,
            error
          );
          this.emitMutationRejected(activeMutation, error);
          queue.shift();
          this.writeMutationQueue(queue);
          continue;
        }

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

  public close(): void {
    if (this.unsubscribeConnection) {
      this.unsubscribeConnection();
    }
    if (this.unsubscribeNetInfo) {
      this.unsubscribeNetInfo();
    }
    if (this.ownsClient) {
      this.convexClient.close();
    }
  }
}

function useSyncArgs(args: Record<string, any> | 'skip' = {}): {
  skipped: boolean;
  parsedArgs: Record<string, any>;
} {
  if (args === 'skip') {
    return { skipped: true, parsedArgs: {} };
  }
  return { skipped: false, parsedArgs: args };
}

/**
 * Custom React Hook that returns local cached values instantly (synchronously),
 * binds UI updates dynamically, and triggers auto-sync in the background.
 * Pass `'skip'` to keep cached data (if any) without opening a subscription.
 */
export function useSyncQuery<T = any>(
  syncEngine: ConvexSyncEngine,
  queryPath: FunctionPath,
  args: Record<string, any> | 'skip' = {}
): T[] {
  return useSyncQueryState<T>(syncEngine, queryPath, args).data;
}

export function useSyncQueryState<T = any>(
  syncEngine: ConvexSyncEngine,
  queryPath: FunctionPath,
  args: Record<string, any> | 'skip' = {}
): SyncQueryState<T> {
  const { skipped, parsedArgs } = useSyncArgs(args);
  const path =
    typeof queryPath === 'string' ? queryPath : resolveFunctionPath(queryPath);
  const serializedArgs = skipped ? 'skip' : canonicalizeArgs(parsedArgs);

  const [state, setState] = useState<SyncQueryState<T>>(() => {
    if (skipped) {
      return { data: [], status: 'missing' };
    }
    const cached = syncEngine.getCachedQueryResults(path, parsedArgs);
    const hasCache = syncEngine.hasCachedQuery(path, parsedArgs);
    const live = syncEngine.isQueryLive(path, parsedArgs);
    return {
      data: cached,
      status: live ? 'live' : hasCache ? 'cache' : 'missing',
    };
  });

  useEffect(() => {
    if (serializedArgs === 'skip') {
      setState({ data: [], status: 'missing' });
      return;
    }
    const nextArgs = JSON.parse(serializedArgs);

    const read = () => {
      const cached = syncEngine.getCachedQueryResults(path, nextArgs) as T[];
      const hasCache = syncEngine.hasCachedQuery(path, nextArgs);
      const live = syncEngine.isQueryLive(path, nextArgs);
      setState({
        data: cached,
        status: live ? 'live' : hasCache ? 'cache' : 'missing',
      });
    };

    read();
    const unsubscribe = syncEngine.subscribeQuery(path, nextArgs, read);
    return unsubscribe;
  }, [syncEngine, path, serializedArgs]);

  return state;
}

export function useSyncDocument<T = any>(
  syncEngine: ConvexSyncEngine,
  queryPath: FunctionPath,
  args: Record<string, any> | 'skip' = {}
): T | null {
  const { skipped, parsedArgs } = useSyncArgs(args);
  const path =
    typeof queryPath === 'string' ? queryPath : resolveFunctionPath(queryPath);
  const serializedArgs = skipped ? 'skip' : canonicalizeArgs(parsedArgs);

  const [data, setData] = useState<T | null>(() =>
    skipped ? null : syncEngine.getCachedDocument(path, parsedArgs)
  );

  useEffect(() => {
    if (serializedArgs === 'skip') {
      setData(null);
      return;
    }
    const nextArgs = JSON.parse(serializedArgs);
    setData(syncEngine.getCachedDocument(path, nextArgs));

    const unsubscribe = syncEngine.subscribeDocument(path, nextArgs, () => {
      setData(syncEngine.getCachedDocument(path, nextArgs));
    });

    return unsubscribe;
  }, [syncEngine, path, serializedArgs]);

  return data;
}

export function useSyncConnection(syncEngine: ConvexSyncEngine): {
  isOnline: boolean;
  queuedCount: number;
} {
  const [isOnline, setIsOnline] = useState(() => syncEngine.getIsOnline());
  const [queuedCount, setQueuedCount] = useState(() =>
    syncEngine.getQueuedMutationCount()
  );

  useEffect(() => {
    const unsubConnection = syncEngine.subscribeConnectionState(setIsOnline);
    const unsubQueue = syncEngine.subscribeQueue(setQueuedCount);
    return () => {
      unsubConnection();
      unsubQueue();
    };
  }, [syncEngine]);

  return { isOnline, queuedCount };
}
