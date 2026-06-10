import AppIntents
import SwiftData

@AssistantIntent(schema: .notes.searchNotes)
public struct SearchConvexIntent: AppIntent {
    public static var title: LocalizedStringResource = "Search App Data"
    public static var description = IntentDescription("Searches the local database cache.")

    @Parameter(title: "Search Query")
    public var searchQuery: String

    @Dependency private var modelContainer: ModelContainer

    public init() {}

    public func perform() async throws -> some IntentResult & ReturnsValue<[ConvexEntityRepresentation]> {
        let context = ModelContext(modelContainer)
        
        do {
            let descriptor = FetchDescriptor<ConvexEntity>()
            let entities = try context.fetch(descriptor)
            
            // Search all indexable keywords in the flat array
            let matched = entities.filter { entity in
                entity.indexableText.contains { keyword in
                    keyword.localizedCaseInsensitiveContains(searchQuery)
                }
            }
            
            let representations = matched.map { 
                ConvexEntityRepresentation(
                    id: $0.id, 
                    table: $0.table, 
                    updatedAt: $0.updatedAt, 
                    indexableText: $0.indexableText
                ) 
            }
            
            return .result(value: representations)
        } catch {
            return .result(value: [])
        }
    }
}
