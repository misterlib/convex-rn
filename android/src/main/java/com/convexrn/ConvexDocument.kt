package com.convexrn

import androidx.appsearch.annotation.Document
import androidx.appsearch.app.AppSearchSchema

@Document
data class ConvexDocument(
    @Document.Namespace
    val namespace: String, // Maps to the table name (e.g. "tasks")

    @Document.Id
    val id: String,

    @Document.Score
    val score: Int = 0,

    @Document.LongProperty
    val updatedAt: Long,

    // AppSearch indexes all entries in this array for full-text search
    @Document.StringProperty(indexingType = AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES)
    val indexableText: List<String>,

    @Document.StringProperty
    val jsonData: String
)
