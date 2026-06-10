// @ts-nocheck
import { ConvexSyncEngine } from '../ConvexSyncEngine';
import { syncStorage } from '../Storage';
import { describe, it, expect, beforeEach } from '@jest/globals';

// Mock NativeConvexBridge to avoid native dependency failures during test
jest.mock('../NativeConvexBridge', () => ({
  applyDelta: jest.fn().mockResolvedValue(undefined),
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
});
