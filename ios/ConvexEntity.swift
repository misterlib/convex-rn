import Foundation
import SwiftData

@Model
public final class ConvexEntity {
    @Attribute(.unique) public var id: String
    public var table: String
    public var updatedAt: Date
    public var indexableText: [String]
    public var jsonData: String
    
    public init(id: String, table: String, updatedAt: Date, indexableText: [String], jsonData: String) {
        self.id = id
        self.table = table
        self.updatedAt = updatedAt
        self.indexableText = indexableText
        self.jsonData = jsonData
    }
}
