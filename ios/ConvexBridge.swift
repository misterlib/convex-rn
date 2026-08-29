import Foundation
import SwiftData
import React
import AppIntents

@objc(ConvexBridge)
public final class ConvexBridge: NSObject {
    private var sharedContainer: ModelContainer?

    // Swift structures for decoding generic JSON deltas
    private struct DatabaseChange: Decodable {
        let type: String
        let table: String
        let id: String
        let indexableText: [String]?
        let jsonData: String?
        let updatedAt: Double?
    }

    private struct DataDelta: Decodable {
        let sequenceNumber: Int
        let timestamp: Double
        let changes: [DatabaseChange]
    }

    override public init() {
        super.init()
        let config = Self.makeModelConfiguration()
        do {
            let container = try ModelContainer(for: ConvexEntity.self, configurations: config)
            self.sharedContainer = container
            
            // Register model container with AppDependencyManager for Apple Intelligence AppIntents
            AppDependencyManager.shared.add(dependency: container)
            print("[ConvexBridge] SwiftData ModelContainer registered with AppDependencyManager.")
        } catch {
            print("[ConvexBridge] Failed to initialize SwiftData ModelContainer: \(error.localizedDescription)")
        }
    }

    /// SwiftData asserts (SIGTRAP) on iOS 26/27 if groupContainer points at an
    /// App Group the host app did not entitle. Fall back to Application Support.
    private static func makeModelConfiguration() -> ModelConfiguration {
        let groupIdentifier = "group.com.convexrn.shared"
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier) != nil {
            return ModelConfiguration(groupContainer: .identifier(groupIdentifier))
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        return ModelConfiguration(url: support.appendingPathComponent("ConvexRN.store"))
    }

    @objc
    public static func requiresMainQueueSetup() -> Bool {
        return false
    }

    @objc
    public func applyDelta(_ jsonString: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let container = sharedContainer else {
            reject("SWIFTDATA_ERROR", "SwiftData container not initialized", nil)
            return
        }

        // Perform write operations on a background task context
        Task {
            let context = ModelContext(container)
            guard let jsonData = jsonString.data(using: .utf8) else {
                reject("PARSE_ERROR", "Invalid UTF-8 string provided", nil)
                return
            }

            do {
                let delta = try JSONDecoder().decode(DataDelta.self, from: jsonData)
                print("[ConvexBridge] Processing generic delta sequence #\(delta.sequenceNumber)")

                for change in delta.changes {
                    let itemId = change.id

                    if change.type == "insert" || change.type == "update" {
                        let table = change.table
                        let indexableText = change.indexableText ?? []
                        let rawJsonData = change.jsonData ?? "{}"
                        let rawTime = change.updatedAt ?? Date().timeIntervalSince1970
                        let updatedAt = Date(timeIntervalSince1970: rawTime / 1000.0) // Convert epoch ms to seconds

                        // Check if item already exists (Upsert)
                        let fetchDescriptor = FetchDescriptor<ConvexEntity>(predicate: #Predicate<ConvexEntity> { $0.id == itemId })
                        let existing = try context.fetch(fetchDescriptor)

                        if let existingEntity = existing.first {
                            existingEntity.table = table
                            existingEntity.indexableText = indexableText
                            existingEntity.jsonData = rawJsonData
                            existingEntity.updatedAt = updatedAt
                        } else {
                            let newEntity = ConvexEntity(
                                id: itemId, 
                                table: table, 
                                updatedAt: updatedAt, 
                                indexableText: indexableText, 
                                jsonData: rawJsonData
                            )
                            context.insert(newEntity)
                        }
                    } else if change.type == "delete" {
                        let fetchDescriptor = FetchDescriptor<ConvexEntity>(predicate: #Predicate<ConvexEntity> { $0.id == itemId })
                        let existing = try context.fetch(fetchDescriptor)
                        if let existingEntity = existing.first {
                            context.delete(existingEntity)
                        }
                    }
                }

                try context.save()
                resolve(true)
            } catch {
                reject("WRITE_ERROR", "Failed to apply and save delta updates: \(error.localizedDescription)", error)
            }
        }
    }
}
