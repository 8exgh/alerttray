import Foundation
import UIKit

class APIService {
    static let shared = APIService()
    
    private let baseURL = "https://alerttray.com"
    private var authToken: String?
    
    private init() {}
    
    func registerDevice(token: String) async throws {
        guard let authToken = authToken else {
            print("❌ No auth token available for device registration")
            throw APIError.notAuthenticated
        }
        
        let url = URL(string: "\(baseURL)/api/devices/register")!
        print("🔵 Registering device at: \(url.absoluteString)")
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        print("🔵 Using Bearer token: \(authToken.prefix(20))...")
        
        let body = ["token": token, "deviceName": UIDevice.current.name, "platform": "ios"]
        request.httpBody = try JSONEncoder().encode(body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        if let httpResponse = response as? HTTPURLResponse {
            print("🔵 Device registration response: \(httpResponse.statusCode)")
            if httpResponse.statusCode != 200 {
                let responseString = String(data: data, encoding: .utf8) ?? "Unable to decode"
                print("❌ Device registration failed: \(responseString)")
            }
        }
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw APIError.requestFailed
        }
        
        print("✅ Device registered successfully")
    }
    
    func login(email: String, password: String) async throws -> User {
        let url = URL(string: "\(baseURL)/api/auth/login")!
        print("🔵 Login attempt to: \(url.absoluteString)")
        print("🔵 Email: \(email)")
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = ["email": email, "password": password]
        request.httpBody = try JSONEncoder().encode(body)
        print("🔵 Request body: \(String(data: request.httpBody!, encoding: .utf8) ?? "nil")")
        
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            
            if let httpResponse = response as? HTTPURLResponse {
                print("🔵 Response status code: \(httpResponse.statusCode)")
                print("🔵 Response headers: \(httpResponse.allHeaderFields)")
            }
            
            let responseString = String(data: data, encoding: .utf8) ?? "Unable to decode response"
            print("🔵 Response body: \(responseString)")
            
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                print("❌ Login failed - Invalid status code or not 200")
                throw APIError.invalidCredentials
            }
            
            let result = try JSONDecoder().decode(LoginResponse.self, from: data)
            self.authToken = result.token
            print("✅ Login successful - Token received: \(result.token.prefix(20))...")
            
            return result.user
        } catch {
            print("❌ Login error: \(error)")
            print("❌ Error type: \(type(of: error))")
            print("❌ Error localized: \(error.localizedDescription)")
            throw error
        }
    }
    
    func fetchNotifications() async throws -> [Notification] {
        guard let authToken = authToken else {
            print("❌ No auth token available for fetching notifications")
            throw APIError.notAuthenticated
        }
        
        let url = URL(string: "\(baseURL)/api/notifications")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            print("❌ Failed to fetch notifications")
            throw APIError.requestFailed
        }
        
        let notifications = try JSONDecoder().decode([Notification].self, from: data)
        return notifications
    }
}

enum APIError: Error {
    case notAuthenticated
    case invalidCredentials
    case requestFailed
}

struct LoginResponse: Codable {
    let success: Bool
    let user: User
    let token: String
}

struct User: Codable {
    let id: String
    let email: String
}
