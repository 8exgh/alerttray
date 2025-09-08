import SwiftUI

struct ContentView: View {
    @State private var isLoggedIn = false
    
    var body: some View {
        if isLoggedIn {
            NotificationListView()
        } else {
            LoginView(isLoggedIn: $isLoggedIn)
        }
    }
}