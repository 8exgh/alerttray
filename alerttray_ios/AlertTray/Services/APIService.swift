import Foundation

class APIService {
    static let shared = APIService()
    
    private let baseURL = "http://localhost:3000"
    private var authToken: String?
    
    private init() {}
    
    func registerDevice(token: String) async throws {
        guard let authToken = authToken else {
            throw APIError.notAuthenticated
        }
        
        let url = URL(string: "\(baseURL)/api/devices/register")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        
        let body = ["token": token, "deviceName": UIDevice.current.name]
        request.httpBody = try JSONEncoder().encode(body)
        
        let (_, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw APIError.requestFailed
        }
    }
    
    func login(email: String, password: String) async throws -> User {
        let url = URL(string: "\(baseURL)/api/auth/login")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = ["email": email, "password": password]
        request.httpBody = try JSONEncoder().encode(body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw APIError.invalidCredentials
        }
        
        let result = try JSONDecoder().decode(LoginResponse.self, from: data)
        self.authToken = result.token
        
        return result.user
    }
}

enum APIError: Error {
    case notAuthenticated
    case invalidCredentials
    case requestFailed
}

struct LoginResponse: Codable {
    let user: User
    let token: String
}

struct User: Codable {
    let id: String
    let email: String
}