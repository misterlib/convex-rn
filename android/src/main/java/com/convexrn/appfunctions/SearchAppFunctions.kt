package com.convexrn.appfunctions

import androidx.appfunctions.AppFunctionContext
import androidx.appfunctions.service.AppFunction
import androidx.appsearch.app.SearchSpec
import androidx.appsearch.platformstorage.PlatformStorage
import com.convexrn.ConvexDocument
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCancellableCoroutine

class SearchAppFunctions {

    /**
     * Searches all local synced database documents matching a text keyword query.
     *
     * @param appFunctionContext Context for Android AppFunction execution.
     * @param query The text search term to search for across all tables.
     * @return A list of matching items represented as summary text descriptions.
     */
    @AppFunction(isDescribedByKDoc = true)
    suspend fun searchConvexData(
        appFunctionContext: AppFunctionContext,
        query: String
    ): List<String> {
        val context = appFunctionContext.context
        
        // Open AppSearch session in this worker context
        val session = suspendCancellableCoroutine { continuation ->
            val sessionFuture = PlatformStorage.createSearchSessionAsync(
                PlatformStorage.SearchContext.Builder(context, "convex_database").build()
            )
            sessionFuture.addListener({
                try {
                    continuation.resume(sessionFuture.get())
                } catch (e: Exception) {
                    continuation.resumeWithException(e)
                }
            }, Executors.newSingleThreadExecutor())
        }

        try {
            // Search all documents in the database
            val searchSpec = SearchSpec.Builder().build()
            val searchResults = session.search(query, searchSpec)
            
            val matchedItems = mutableListOf<String>()
            val page = suspendCancellableCoroutine { continuation ->
                val nextFuture = searchResults.nextPageAsync
                nextFuture.addListener({
                    try {
                        continuation.resume(nextFuture.get())
                    } catch (e: Exception) {
                        continuation.resumeWithException(e)
                    }
                }, Executors.newSingleThreadExecutor())
            }

            for (result in page) {
                val doc = result.genericDocument.toDocumentClass(ConvexDocument::class.java)
                val titleText = doc.indexableText.firstOrNull() ?: "Untitled"
                val subtitleText = doc.indexableText.drop(1).joinToString(", ")
                matchedItems.add("[$titleText] $subtitleText (Table: ${doc.namespace})")
            }

            return matchedItems
        } catch (e: Exception) {
            return listOf("Error performing search: ${e.message}")
        } finally {
            session.close()
        }
    }
}
