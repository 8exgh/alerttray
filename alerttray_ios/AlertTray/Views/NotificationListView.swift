import SwiftUI

struct NotificationListView: View {
    @EnvironmentObject var notificationStore: NotificationStore
    
    var body: some View {
        NavigationView {
            List {
                if notificationStore.notifications.isEmpty {
                    Text("No notifications yet")
                        .foregroundColor(.gray)
                        .padding()
                } else {
                    ForEach(notificationStore.notifications) { notification in
                        NotificationRow(notification: notification)
                            .onTapGesture {
                                notificationStore.markAsRead(notification.id)
                            }
                    }
                }
            }
            .navigationTitle("Notifications")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Text("\(unreadCount) unread")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }
        }
    }
    
    var unreadCount: Int {
        notificationStore.notifications.filter { !$0.isRead }.count
    }
}

struct NotificationRow: View {
    let notification: Notification
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(notification.title)
                    .font(.headline)
                    .foregroundColor(notification.isRead ? .gray : .primary)
                
                Spacer()
                
                if !notification.isRead {
                    Circle()
                        .fill(Color.blue)
                        .frame(width: 8, height: 8)
                }
            }
            
            Text(notification.message)
                .font(.subheadline)
                .foregroundColor(.gray)
                .lineLimit(2)
            
            Text(notification.receivedAt, style: .relative)
                .font(.caption)
                .foregroundColor(.gray)
        }
        .padding(.vertical, 4)
    }
}