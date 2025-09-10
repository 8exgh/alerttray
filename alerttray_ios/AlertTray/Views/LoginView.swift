import SwiftUI

struct LoginView: View {
    @Binding var isLoggedIn: Bool
    @State private var email = ""
    @State private var password = ""
    @State private var showingError = false
    @State private var errorMessage = ""
    
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                Text("AlertTray")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .padding(.bottom, 30)
                
                VStack(spacing: 15) {
                    TextField("Email", text: $email)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                        .autocapitalization(.none)
                        .keyboardType(.emailAddress)
                    
                    SecureField("Password", text: $password)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                }
                .padding(.horizontal)
                
                Button(action: login) {
                    Text("Login")
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.blue)
                        .cornerRadius(10)
                }
                .padding(.horizontal)
                
                Spacer()
            }
            .padding()
            .navigationBarHidden(true)
            .alert("Error", isPresented: $showingError) {
                Button("OK", role: .cancel) { }
            } message: {
                Text(errorMessage)
            }
        }
    }
    
    func login() {
        print("🟢 Login button pressed")
        print("🟢 Email entered: \(email)")
        print("🟢 Password length: \(password.count) characters")
        
        guard !email.isEmpty && !password.isEmpty else {
            print("⚠️ Empty email or password")
            errorMessage = "Please enter both email and password"
            showingError = true
            return
        }
        
        Task {
            do {
                print("🟢 Starting login task...")
                let user = try await APIService.shared.login(email: email, password: password)
                print("🟢 Login successful for user: \(user.email)")
                
                await MainActor.run {
                    print("🟢 Setting isLoggedIn to true")
                    isLoggedIn = true
                }
            } catch {
                print("🔴 Login failed with error: \(error)")
                
                await MainActor.run {
                    if let apiError = error as? APIError {
                        switch apiError {
                        case .invalidCredentials:
                            errorMessage = "Invalid email or password"
                        case .notAuthenticated:
                            errorMessage = "Authentication required"
                        case .requestFailed:
                            errorMessage = "Network request failed"
                        }
                    } else {
                        errorMessage = "Login failed: \(error.localizedDescription)"
                    }
                    print("🔴 Showing error: \(errorMessage)")
                    showingError = true
                }
            }
        }
    }
}