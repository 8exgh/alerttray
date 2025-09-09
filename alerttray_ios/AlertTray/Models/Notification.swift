import Foundation
import SwiftUI

struct Notification: Identifiable, Codable {
    let id: String
    let title: String
    let message: String
    let receivedAt: Date
    var isRead: Bool = false
}

class NotificationStore: ObservableObject {
    static let shared = NotificationStore()
    
    @Published var notifications: [Notification] = []
    
    private init() {
        loadNotifications()
    }
    
    func addNotification(_ notification: Notification) {
        notifications.insert(notification, at: 0)
        saveNotifications()
    }
    
    func markAsRead(_ id: String) {
        if let index = notifications.firstIndex(where: { $0.id == id }) {
            notifications[index].isRead = true
            saveNotifications()
        }
    }
    
    private func saveNotifications() {
        if let encoded = try? JSONEncoder().encode(notifications) {
            UserDefaults.standard.set(encoded, forKey: "notifications")
        }
    }
    
    private func loadNotifications() {
        if let data = UserDefaults.standard.data(forKey: "notifications"),
           let decoded = try? JSONDecoder().decode([Notification].self, from: data) {
            notifications = decoded
        }
    }
}