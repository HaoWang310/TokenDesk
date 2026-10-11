import Foundation
import Network

final class BrowserBridge {
    static let port: UInt16 = 18743
    static let pairingKeyName = "TokenDeskBrowserPairingKey_v1"

    static var pairingCode: String {
        if let existing = UserDefaults.standard.string(forKey: pairingKeyName), existing.count >= 32 {
            return existing
        }
        let value = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
                  + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        UserDefaults.standard.set(value, forKey: pairingKeyName)
        return value
    }

    private let queue = DispatchQueue(label: "com.tokendesk.browserbridge", qos: .utility)
    private var listener: NWListener?
    private let expectedCode: String
    private let onUsage: (BrowserUsage) -> Void
    private let onState: (String) -> Void

    init(onUsage: @escaping (BrowserUsage) -> Void, onState: @escaping (String) -> Void) {
        self.expectedCode = Self.pairingCode
        self.onUsage = onUsage
        self.onState = onState
    }

    func start() {
        do {
            let parameters = NWParameters.tcp
            // Bind IPv4 loopback ONLY; do not listen to the LAN or the internet.
            parameters.requiredLocalEndpoint = .hostPort(
                host: NWEndpoint.Host("127.0.0.1"),
                port: NWEndpoint.Port(rawValue: Self.port)!)
            let server = try NWListener(using: parameters)
            server.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready: self?.notify("网页连接端口已就绪（127.0.0.1:\(Self.port)）")
                case .failed(let error): self?.notify("网页连接启动失败：\(error.localizedDescription)")
                default: break
                }
            }
            server.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener = server
            server.start(queue: queue)
        } catch {
            notify("无法启动网页连接：\(error.localizedDescription)")
        }
    }

    private func notify(_ status: String) {
        DispatchQueue.main.async { [onState] in onState(status) }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            var collected = buffer
            if let data { collected.append(data) }
            if collected.count > 16_384 {
                self.respond(connection, code: 413, message: "Too Large")
                return
            }
            guard let range = collected.range(of: Data([13, 10, 13, 10])) else {
                if isComplete || error != nil { self.respond(connection, code: 400, message: "Incomplete headers") }
                else { self.receive(connection, buffer: collected) }
                return
            }
            let headers = collected.subdata(in: collected.startIndex..<range.lowerBound)
            guard let headerText = String(data: headers, encoding: .utf8) else {
                self.respond(connection, code: 400, message: "Bad request"); return
            }
            let lines = headerText.components(separatedBy: "\r\n")
            let requestLine = lines.first ?? ""
            // Browsers may preflight requests with a custom X-TokenDesk-Key
            // header. v1.3.1 incorrectly answered 404 to OPTIONS requests.
            if requestLine == "OPTIONS /ingest HTTP/1.1" || requestLine == "OPTIONS /health HTTP/1.1" {
                self.respond(connection, code: 204, message: "No Content", body: "")
                return
            }
            // A harmless, read-only probe for Chrome extension diagnostics.
            if requestLine == "GET /health HTTP/1.1" {
                self.respond(connection, code: 200, message: "OK",
                             body: "{\"ok\":true,\"app\":\"TokenDesk\"}")
                return
            }
            guard requestLine == "POST /ingest HTTP/1.1",
                  !lines.dropFirst().contains(where: { $0.lowercased().hasPrefix("transfer-encoding:") })
            else { self.respond(connection, code: 404, message: "Not found"); return }
            let codes = lines.dropFirst().filter { $0.lowercased().hasPrefix("x-tokendesk-key:") }
            let lengths = lines.dropFirst().filter { $0.lowercased().hasPrefix("content-length:") }
            guard codes.count == 1, lengths.count == 1 else {
                self.respond(connection, code: 401, message: "Unauthorized"); return
            }
            let key = codes[0].split(separator: ":", maxSplits: 1).last.map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard key == self.expectedCode else {
                self.respond(connection, code: 401, message: "Unauthorized"); return
            }
            let contentLength = lengths[0].split(separator: ":", maxSplits: 1).last.map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard let length = Int(contentLength), (1...4096).contains(length) else {
                self.respond(connection, code: 400, message: "Invalid length"); return
            }
            let start = range.upperBound
            if collected.count - start < length {
                if isComplete || error != nil { self.respond(connection, code: 400, message: "Incomplete body") }
                else { self.receive(connection, buffer: collected) }
                return
            }
            let body = collected.subdata(in: start..<(start + length))
            guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
                  let usage = BrowserUsage.parse(obj) else {
                self.respond(connection, code: 422, message: "Invalid usage"); return
            }
            DispatchQueue.main.async { [onUsage] in onUsage(usage) }
            self.respond(connection, code: 200, message: "OK")
        }
    }

    private func respond(_ connection: NWConnection, code: Int,
                         message: String, body: String? = nil) {
        let contents = body ?? "{\"ok\":\(code == 200 ? "true" : "false"),\"message\":\"\(message)\"}"
        let header = "HTTP/1.1 \(code) \(message)\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: \(contents.utf8.count)\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type, X-TokenDesk-Key\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        connection.send(content: Data((header + contents).utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
