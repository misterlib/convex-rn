import { useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { ConvexSyncEngine, useSyncQuery } from 'convex-rn';

export interface Task {
  _id: string;
  title: string;
  completed: boolean;
  updatedAt: number;
}

// Initialize the generic ConvexSyncEngine with mappings and indexing rules
const syncEngine = new ConvexSyncEngine(
  'https://exquisite-reindeer-300.convex.cloud',
  {
    schemaMap: {
      'tasks:list': { table: 'tasks' },
    },
    indexRules: {
      // Generates a flat keyword array of [title, completed/pending] for Siri & Gemini
      tasks: (doc) => [doc.title, doc.completed ? 'completed' : 'pending'],
    },
  }
);

export default function App() {
  const [syncing, setSyncing] = useState(false);

  // Hook handles local caching synchronously, listens to network reconnects,
  // and binds component updates reactively when sync finishes.
  const tasks = useSyncQuery<Task>(syncEngine, 'tasks:list');

  const triggerSync = async () => {
    setSyncing(true);
    try {
      // Manual sync trigger
      await syncEngine.syncQuery('tasks:list');
    } catch (e) {
      console.error('Sync failed:', e);
    } finally {
      setSyncing(false);
    }
  };

  const toggleTask = async (task: Task) => {
    const nextCompleted = !task.completed;
    // Perform mutation - writes locally, updates Siri/Gemini, and queues retry if offline
    await syncEngine.performMutation(
      'tasks',
      'tasks:toggle',
      task._id,
      { completed: nextCompleted, title: task.title },
      { id: task._id, completed: nextCompleted }
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Convex Local-First Sync</Text>

      {syncing ? (
        <ActivityIndicator size="small" color="#007AFF" style={styles.loader} />
      ) : (
        <TouchableOpacity style={styles.syncButton} onPress={triggerSync}>
          <Text style={styles.syncButtonText}>Sync Query (tasks:list)</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.subtitle}>
        Tasks (Cached locally & native-synced):
      </Text>

      <FlatList
        data={tasks}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.taskItem}
            onPress={() => toggleTask(item)}
          >
            <Text
              style={[styles.taskText, item.completed && styles.taskCompleted]}
            >
              {item.completed ? '☑' : '☐'} {item.title}
            </Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No tasks cached. Press Sync to fetch from Convex.
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 60,
    paddingHorizontal: 20,
    backgroundColor: '#F5F5F7',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1D1D1F',
    textAlign: 'center',
    marginBottom: 20,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#86868B',
    marginTop: 20,
    marginBottom: 10,
  },
  syncButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 10,
  },
  syncButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
  },
  loader: {
    marginVertical: 12,
  },
  taskItem: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 8,
    marginVertical: 6,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  taskText: {
    fontSize: 16,
    color: '#1D1D1F',
  },
  taskCompleted: {
    textDecorationLine: 'line-through',
    color: '#86868B',
  },
  emptyText: {
    textAlign: 'center',
    color: '#86868B',
    marginTop: 40,
    fontStyle: 'italic',
  },
});
