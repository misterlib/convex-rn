// @ts-nocheck
import { ConvexSyncEngine } from '../ConvexSyncEngine';
import { syncStorage } from '../Storage';
import { describe, it, expect, beforeEach } from '@jest/globals';

// Mock NativeConvexBridge to avoid native dependency failures during test
jest.mock('../NativeConvexBridge', () => ({
  applyDelta: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => {
    throw new Error('MMKV unavailable in tests');
  },
}));

// Mock variables to capture callbacks inside tests
let mockConnectionCallback: any = null;
let mockQueryCallback: any = null;
let mockClientInstance: any = null;
let mockHttpClientInstance: any = null;

// Mock convex/browser
jest.mock('convex/browser', () => {
  const mockSubscribeToConnectionState = jest
    .fn()
    .mockImplementation((cb: any) => {
      mockConnectionCallback = cb;
      return jest.fn(); // returns unsubscribe
    });

  const mockOnUpdate = jest
    .fn()
    .mockImplementation((_queryPath: any, _args: any, callback: any) => {
      mockQueryCallback = callback;
      return jest.fn(); // returns unsubscribe
    });

  const mockMutation = jest.fn().mockResolvedValue(undefined);
  const mockQuery = jest.fn().mockResolvedValue([]);

  const mockClose = jest.fn();

  return {
    ConvexClient: jest.fn().mockImplementation(() => {
      mockClientInstance = {
        subscribeToConnectionState: mockSubscribeToConnectionState,
        onUpdate: mockOnUpdate,
        mutation: mockMutation,
        close: mockClose,
      };
      return mockClientInstance;
    }),
    ConvexHttpClient: jest.fn().mockImplementation(() => {
      mockHttpClientInstance = {
        query: mockQuery,
      };
      return mockHttpClientInstance;
    }),
  };
});

describe('ConvexSyncEngine', () => {
  const convexUrl = 'https://mock-deployment.convex.cloud';
  let engine: ConvexSyncEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    syncStorage.clear();
    mockConnectionCallback = null;
    mockQueryCallback = null;
    mockClientInstance = null;
    mockHttpClientInstance = null;

    engine = new ConvexSyncEngine(convexUrl, {
      schemaMap: {
        'tasks:list': { table: 'tasks' },
      },
      indexRules: {
        tasks: (doc) => [doc.title],
      },
    });
  });

  it('should instantiate ConvexClient and ConvexHttpClient correctly', () => {
    const { ConvexClient, ConvexHttpClient } = require('convex/browser');
    expect(ConvexClient).toHaveBeenCalledWith(convexUrl);
    expect(ConvexHttpClient).toHaveBeenCalledWith(convexUrl);
    expect(mockClientInstance.subscribeToConnectionState).toHaveBeenCalled();
  });

  it('should subscribe to connection state and process mutation queue on reconnect', async () => {
    // Queue an offline mutation
    const mutation = {
      queueId: 'mut_1',
      tableName: 'tasks',
      mutationPath: 'tasks:create',
      docId: '123',
      localFields: { title: 'New Task' },
      mutationArgs: { title: 'New Task' },
      timestamp: Date.now(),
    };
    syncStorage.setItem('offline_mutations', JSON.stringify([mutation]));

    // Simulate going offline first
    mockConnectionCallback({ isWebSocketConnected: false });

    // Verify queue is not processed while offline
    expect(mockClientInstance.mutation).not.toHaveBeenCalled();

    // Simulate going online
    mockConnectionCallback({ isWebSocketConnected: true });

    // Wait for the async queue processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockClientInstance.mutation).toHaveBeenCalledWith('tasks:create', {
      title: 'New Task',
    });
    expect(syncStorage.getItem('offline_mutations')).toBe('[]');
  });

  it('should handle real-time query updates and update MMKV cache', async () => {
    const onChange = jest.fn();

    // Subscribe to query
    const unsubscribe = engine.subscribeQuery('tasks:list', {}, onChange);

    expect(mockClientInstance.onUpdate).toHaveBeenCalledWith(
      'tasks:list',
      {},
      expect.any(Function),
      expect.any(Function)
    );

    // Trigger WebSocket query push
    const freshTasks = [{ _id: '1', title: 'Task 1', completed: false }];
    await mockQueryCallback(freshTasks);

    // Verify cache is updated
    const cachedQuery = JSON.parse(
      syncStorage.getItem('query::tasks:list::{}') || '[]'
    );
    expect(cachedQuery).toEqual(freshTasks);

    // Verify change listener is called
    expect(onChange).toHaveBeenCalled();

    // Unsubscribe
    unsubscribe();
  });

  it('should execute mutations and queue them if connection fails', async () => {
    // Mock mutation to throw a network error
    mockClientInstance.mutation.mockRejectedValueOnce(
      new Error('WebSocket closed')
    );

    await engine.performMutation(
      'tasks',
      'tasks:create',
      '123',
      { title: 'Optimistic' },
      { title: 'Optimistic' }
    );

    // Verify queued in offline mutations storage
    const offlineMutations = JSON.parse(
      syncStorage.getItem('offline_mutations') || '[]'
    );
    expect(offlineMutations.length).toBe(1);
    expect(offlineMutations[0].mutationPath).toBe('tasks:create');
  });

  it('should discard mutation and remove it from queue if it fails with validation/application error', async () => {
    // Mock mutation to throw a validation/application error
    mockClientInstance.mutation.mockRejectedValueOnce(
      new Error('Validation failed: Title is required')
    );

    // Directly put mutation in queue
    const mutation = {
      queueId: 'mut_2',
      tableName: 'tasks',
      mutationPath: 'tasks:create',
      docId: '123',
      localFields: { title: '' },
      mutationArgs: { title: '' },
      timestamp: Date.now(),
    };
    syncStorage.setItem('offline_mutations', JSON.stringify([mutation]));

    await engine.processMutationQueue();

    // Verify mutation was discarded and removed from queue
    expect(syncStorage.getItem('offline_mutations')).toBe('[]');
  });

  it('should treat {a,b} and {b,a} as the same query cache key', async () => {
    const onChange = jest.fn();
    engine.subscribeQuery(
      'tasks:list',
      { ministryId: 'm1', userId: 'u1' },
      onChange
    );

    await mockQueryCallback([{ _id: '1', title: 'Task 1' }]);

    expect(
      engine.getCachedQueryResults('tasks:list', {
        userId: 'u1',
        ministryId: 'm1',
      })
    ).toEqual([{ _id: '1', title: 'Task 1' }]);
    expect(
      engine.hasCachedQuery('tasks:list', { userId: 'u1', ministryId: 'm1' })
    ).toBe(true);
  });

  it('should expose connection and queue observers', async () => {
    const connection = jest.fn();
    const queue = jest.fn();
    engine.subscribeConnectionState(connection);
    engine.subscribeQueue(queue);

    expect(connection).toHaveBeenCalledWith(true);
    expect(queue).toHaveBeenCalledWith(0);
    expect(engine.getIsOnline()).toBe(true);
    expect(engine.getQueuedMutationCount()).toBe(0);

    mockClientInstance.mutation.mockRejectedValueOnce(
      new Error('WebSocket closed')
    );
    await engine.performMutation(
      'tasks',
      'tasks:create',
      '123',
      { title: 'Queued' },
      { title: 'Queued' }
    );

    expect(engine.getQueuedMutationCount()).toBe(1);
    expect(queue).toHaveBeenCalledWith(1);
  });

  it('should upsert by match when docId is omitted', async () => {
    syncStorage.setItem(
      'cache_table_tasks:task_1',
      JSON.stringify({ _id: 'task_1', title: 'Old', date: '20240101' })
    );
    syncStorage.setItem('cache_table_tasks__ids', JSON.stringify(['task_1']));

    mockClientInstance.mutation.mockRejectedValueOnce(
      new Error('WebSocket closed')
    );

    await engine.performMutation({
      table: 'tasks',
      mutationPath: 'tasks:update',
      match: (doc) => doc.date === '20240101',
      localFields: { title: 'New' },
      mutationArgs: { date: '20240101', title: 'New' },
    });

    expect(engine.getCachedItem('tasks', 'task_1').title).toBe('New');
    const queue = JSON.parse(syncStorage.getItem('offline_mutations') || '[]');
    expect(queue[0].docId).toBe('task_1');
  });

  it('should emit onMutationRejected when a validation error discards a write', async () => {
    const rejected = jest.fn();
    engine.onMutationRejected(rejected);
    mockClientInstance.mutation.mockRejectedValueOnce(
      new Error('Validation failed: Title is required')
    );

    syncStorage.setItem(
      'offline_mutations',
      JSON.stringify([
        {
          queueId: 'mut_3',
          tableName: 'tasks',
          mutationPath: 'tasks:create',
          docId: '123',
          localFields: { title: '' },
          mutationArgs: { title: '' },
          timestamp: Date.now(),
        },
      ])
    );

    await engine.processMutationQueue();
    expect(rejected).toHaveBeenCalled();
    expect(rejected.mock.calls[0][0].queueId).toBe('mut_3');
  });

  it('should skip non-array query results without throwing', async () => {
    const onChange = jest.fn();
    engine.subscribeQuery('tasks:list', {}, onChange);
    await mockQueryCallback({ users: [], ministryMembers: [] });
    expect(onChange).toHaveBeenCalled();
    expect(engine.getCachedQueryResults('tasks:list', {})).toEqual([]);
  });

  it('should accept a shared ConvexClient without constructing another', () => {
    const { ConvexClient } = require('convex/browser');
    ConvexClient.mockClear();

    const shared = {
      subscribeToConnectionState: jest.fn().mockReturnValue(jest.fn()),
      onUpdate: jest.fn().mockReturnValue(jest.fn()),
      mutation: jest.fn(),
      close: jest.fn(),
      setAuth: jest.fn(),
    };

    const sharedEngine = new ConvexSyncEngine(convexUrl, {
      schemaMap: { 'tasks:list': { table: 'tasks' } },
      client: shared as any,
    });

    expect(ConvexClient).not.toHaveBeenCalled();
    sharedEngine.setAuth(async () => 'token');
    expect(shared.setAuth).toHaveBeenCalled();
    sharedEngine.close();
    expect(shared.close).not.toHaveBeenCalled();
  });

  it('should migrate a legacy table blob into per-id keys', () => {
    syncStorage.setItem(
      'cache_table_tasks',
      JSON.stringify([{ _id: 'a', title: 'Legacy' }])
    );
    expect(engine.getCachedItem('tasks', 'a')).toEqual({
      _id: 'a',
      title: 'Legacy',
    });
    expect(syncStorage.getItem('cache_table_tasks')).toBeNull();
  });
});
