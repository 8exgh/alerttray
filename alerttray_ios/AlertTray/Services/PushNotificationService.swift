import UserNotifications
import UIKit

class PushNotificationService: NSObject {
    static let shared = PushNotificationService()
    
    private override init() {
        super.init()
    }
    
    func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, error in
            if granted {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }
    
    func handleRegistration(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        
        // Send token to backend
        Task {
            try await APIService.shared.registerDevice(token: token)
        }
    }
    
    func handleNotification(_ userInfo: [AnyHashable: Any]) {
        guard let aps = userInfo["aps"] as? [String: Any],
              let alert = aps["alert"] as? [String: Any],
              let title = alert["title"] as? String,
              let body = alert["body"] as? String else {
            return
        }
        
        // Extract custom data
        let notificationId = userInfo["notificationId"] as? String
        
        // Update local storage and UI
        NotificationStore.shared.addNotification(
            Notification(
                id: notificationId ?? UUID().uuidString,
                title: title,
                message: body,
                receivedAt: Date()
            )
        )
    }
}