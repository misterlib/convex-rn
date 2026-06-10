import AppIntents
import SwiftData
import Foundation

@AppEntity(schema: .notes.note)
public struct ConvexEntityRepresentation: AppEntity, IndexedEntity {
    public static var defaultQuery = ConvexEntityQuery()
    
    public var id: String
    @Property(title: "Table") public var table: String
    @Property(title: "Updated At") public var updatedAt: Date
    @Property(title: "Keywords") public var indexableText: [String]

    public var displayRepresentation: DisplayRepresentation {
        let titleText = indexableText.first ?? "Untitled \(table)"
        let subtitleText = indexableText.dropFirst().joined(separator: ", ")
        return DisplayRepresentation(
            title: "\(titleText)", 
            subtitle: "\(subtitleText)"
        )
    }
    
    public init(id: String, table: String, updatedAt: Date, indexableText: [String]) {
        self.id = id
        self.table = table
        self.updatedAt = updatedAt
        self.indexableText = indexableText
    }
}

public struct ConvexEntityQuery: EntityQuery {
    @Dependency private var modelContainer: ModelContainer

    public init() {}

    // Resolve specific entities by ID
    public func entities(for ids: [String]) async throws -> [ConvexEntityRepresentation] {
        let context = ModelContext(modelContainer)
        let descriptor = FetchDescriptor<ConvexEntity>(predicate: #Predicate<ConvexEntity> { ids.contains($0.id) })
        let models = try context.fetch(descriptor)
        return models.map { ConvexEntityRepresentation(id: $0.id, table: $0.table, updatedAt: $0.updatedAt, indexableText: $0.indexableText) }
    }

    // Suggested entities shown in Shortcuts/Siri configuration
    public func suggestedEntities() async throws -> [ConvexEntityRepresentation] {
        let context = ModelContext(modelContainer)
        let descriptor = FetchDescriptor<ConvexEntity>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
        let models = try context.fetch(descriptor)
        return models.map { ConvexEntityRepresentation(id: $0.id, table: $0.table, updatedAt: $0.updatedAt, indexableText: $0.indexableText) }
    }
}

// Conforming to EntityStringQuery allows Siri's LLM to run text queries directly against this store
extension ConvexEntityQuery: EntityStringQuery {
    public func entities(matching string: String) async throws -> [ConvexEntityRepresentation] {
        let context = ModelContext(modelContainer)
        let descriptor = FetchDescriptor<ConvexEntity>()
        let models = try context.fetch(descriptor)
        
        // Filter based on search query matching any flat indexable keywords
        let filtered = models.filter { model in
            model.indexableText.contains { keyword in
                keyword.localizedCaseInsensitiveContains(string)
            }
        }
        return filtered.map { ConvexEntityRepresentation(id: $0.id, table: $0.table, updatedAt: $0.updatedAt, indexableText: $0.indexableText) }
    }
}
