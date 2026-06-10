package com.convexrn

import android.content.Context
import androidx.appsearch.app.PutDocumentsRequest
import androidx.appsearch.app.RemoveByDocumentIdRequest
import androidx.appsearch.app.SetSchemaRequest
import androidx.appsearch.platformstorage.PlatformStorage
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ConvexBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val appContext: Context = reactContext.applicationContext

    override fun getName(): String {
        return "ConvexBridge"
    }

    @ReactMethod
    fun applyDelta(jsonString: String, promise: Promise) {
        executor.execute {
            try {
                val json = JSONObject(jsonString)
                val seqNum = json.getInt("sequenceNumber")
                val changes = json.getJSONArray("changes")

                // Open AppSearch session
                val sessionFuture = PlatformStorage.createSearchSessionAsync(
                    PlatformStorage.SearchContext.Builder(appContext, "convex_database").build()
                )

                Futures.addCallback(sessionFuture, object : FutureCallback<PlatformStorage.SearchSession> {
                    override fun onSuccess(session: PlatformStorage.SearchSession?) {
                        if (session == null) {
                            promise.reject("APPSEARCH_ERROR", "Failed to retrieve AppSearch session")
                            return
                        }

                        // Register generic schema
                        val schemaFuture = session.setSchemaAsync(
                            SetSchemaRequest.Builder()
                                .addDocumentClasses(ConvexDocument::class.java)
                                .build()
                        )

                        Futures.addCallback(schemaFuture, object : FutureCallback<SetSchemaRequest.Response> {
                            override fun onSuccess(response: SetSchemaRequest.Response?) {
                                // Maps namespace (table name) to Put builders to allow multi-table batching
                                val putsByTable = mutableMapOf<String, PutDocumentsRequest.Builder>()
                                val removesByTable = mutableMapOf<String, MutableList<String>>()

                                for (i in 0 until changes.length()) {
                                    val change = changes.getJSONObject(i)
                                    val table = change.getString("table")
                                    val type = change.getString("type")
                                    val id = change.getString("id")

                                    if (type == "insert" || type == "update") {
                                        val indexableTextArr = change.optJSONArray("indexableText")
                                        val indexableText = mutableListOf<String>()
                                        if (indexableTextArr != null) {
                                            for (j in 0 until indexableTextArr.length()) {
                                                indexableText.add(indexableTextArr.getString(j))
                                            }
                                        }

                                        val jsonData = change.optString("jsonData", "{}")
                                        val updatedAt = change.optLong("updatedAt", System.currentTimeMillis())

                                        val document = ConvexDocument(
                                            namespace = table,
                                            id = id,
                                            updatedAt = updatedAt,
                                            indexableText = indexableText,
                                            jsonData = jsonData
                                        )

                                        val builder = putsByTable.getOrPut(table) { PutDocumentsRequest.Builder() }
                                        builder.addDocuments(document)
                                    } else if (type == "delete") {
                                        val list = removesByTable.getOrPut(table) { mutableListOf() }
                                        list.add(id)
                                    }
                                }

                                val futures = mutableListOf<ListenableFuture<*>>()

                                // Queue all inserts/updates grouped by table/namespace
                                for ((_, builder) in putsByTable) {
                                    futures.add(session.putAsync(builder.build()))
                                }

                                // Queue all deletions grouped by table/namespace
                                for ((table, ids) in removesByTable) {
                                    val removeRequest = RemoveByDocumentIdRequest.Builder(table)
                                        .addIds(ids)
                                        .build()
                                    futures.add(session.removeAsync(removeRequest))
                                }

                                if (futures.isEmpty()) {
                                    session.close()
                                    promise.resolve(true)
                                    return
                                }

                                // Wait for all operations to write to disk
                                val combined = Futures.allAsList(futures)
                                Futures.addCallback(combined, object : FutureCallback<List<*>> {
                                    override fun onSuccess(result: List<*>?) {
                                        session.close()
                                        promise.resolve(true)
                                    }

                                    override fun onFailure(t: Throwable) {
                                        session.close()
                                        promise.reject("WRITE_ERROR", "Failed to write documents to AppSearch: ${t.message}", t)
                                    }
                                }, executor)
                            }

                            override fun onFailure(t: Throwable) {
                                session.close()
                                promise.reject("SCHEMA_ERROR", "Failed to set AppSearch schema: ${t.message}", t)
                            }
                        }, executor)
                    }

                    override fun onFailure(t: Throwable) {
                        promise.reject("APPSEARCH_ERROR", "Failed to open AppSearch session: ${t.message}", t)
                    }
                }, executor)

            } catch (e: Exception) {
                promise.reject("PARSE_ERROR", "Failed to parse database delta: ${e.message}", e)
            }
        }
    }
}
