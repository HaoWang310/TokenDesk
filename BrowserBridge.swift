import Foundation
import Network

struct RunningChatTask: Equatable, Identifiable {
    enum Phase: String {
        case thinking
        case working
    }

    let id: String
    let phase: Phase
    let modelName: String?
    let title: String
    let pageURL: String
    let startedAt: Date
    let lastSeenAt: Date
}

struct DailyUsageStat: Equatable, Identifiable {
    let day: String
    let activeSeconds: Int
    let weeklyQuotaUsed: Int

    var id: String { day }
}

struct RunningTaskSnapshot {
    let tasks: [RunningChatTask]
    let usageDays: [DailyUsageStat]
    let observedAt: Date

    static func parse(_ obj: [String: Any]) -> RunningTaskSnapshot? {
        guard let rawTasks = obj["tasks"] as? [[String: Any]], rawTasks.count <= 32 else { return nil }
        let observedRaw = (obj["observedAt"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970
        let observedAt = Date(timeIntervalSince1970: observedRaw > 10_000_000_000 ? observedRaw / 1000 : observedRaw)
        var tasks: [RunningChatTask] = []
        var seen = Set<String>()
        for raw in rawTasks {
            guard let id = raw["id"] as? String, !id.isEmpty, id.count <= 180,
                  let titleRaw = raw["title"] as? String, titleRaw.count <= 160,
                  let pageURL = raw["pageURL"] as? String, pageURL.count <= 600,
                  let url = URL(string: pageURL),
                  ["chatgpt.com", "chat.openai.com"].contains(url.host?.lowercased() ?? "") else { continue }
            if seen.contains(id) { continue }
            seen.insert(id)
            let startedRaw = (raw["startedAt"] as? NSNumber)?.doubleValue ?? observedRaw
            let seenRaw = (raw["lastSeenAt"] as? NSNumber)?.doubleValue ?? observedRaw
            func date(_ value: Double) -> Date {
                Date(timeIntervalSince1970: value > 10_000_000_000 ? value / 1000 : value)
            }
            let title = titleRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            let phaseRaw = (raw["phase"] as? String)?.lowercased() ?? "working"
            let phase: RunningChatTask.Phase = phaseRaw == "thinking" ? .thinking : .working
            let modelRaw = ((raw["model"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let modelName = modelRaw.isEmpty ? nil : String(modelRaw.prefix(64))
            tasks.append(RunningChatTask(id: id,
                                         phase: phase,
                                         modelName: modelName,
                                         title: title.isEmpty ? "ChatGPT 任务" : title,
                                         pageURL: pageURL,
                                         startedAt: date(startedRaw),
                                         lastSeenAt: date(seenRaw)))
        }

        var usageDays: [DailyUsageStat] = []
        if let rawDays = obj["usageDays"] as? [[String: Any]], rawDays.count <= 8 {
            for item in rawDays {
                guard let day = item["day"] as? String,
                      day.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
                      let activeNumber = item["activeSeconds"] as? NSNumber,
                      let quotaNumber = item["weeklyQuotaUsed"] as? NSNumber else { continue }
                let active = activeNumber.intValue
                let quota = quotaNumber.intValue
                guard Double(active) == activeNumber.doubleValue,
                      Double(quota) == quotaNumber.doubleValue,
                      (0...86_400).contains(active),
                      (0...500).contains(quota) else { continue }
                usageDays.append(DailyUsageStat(day: day,
                                                activeSeconds: active,
                                                weeklyQuotaUsed: quota))
            }
        }
        usageDays.sort { $0.day < $1.day }
        return RunningTaskSnapshot(tasks: tasks.sorted { $0.startedAt < $1.startedAt },
                                   usageDays: usageDays,
                                   observedAt: observedAt)
    }
}

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
    private let onTasks: (RunningTaskSnapshot) -> Void
    private let onState: (String) -> Void

    init(onUsage: @escaping (BrowserUsage) -> Void,
         onTasks: @escaping (RunningTaskSnapshot) -> Void,
         onState: @escaping (String) -> Void) {
        self.expectedCode = Self.pairingCode
        self.onUsage = onUsage
        self.onTasks = onTasks
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
        let handler = self.onState
        DispatchQueue.main.async {
            handler(status)
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32_768) { [weak self] data, _, isComplete, error in
            guard let self = self else { connection.cancel(); return }
            var collected = buffer
            if let data = data { collected.append(data) }
            if collected.count > 65_536 {
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
            if requestLine == "OPTIONS /ingest HTTP/1.1" ||
               requestLine == "OPTIONS /tasks HTTP/1.1" ||
               requestLine == "OPTIONS /health HTTP/1.1" {
                self.respond(connection, code: 204, message: "No Content", body: "")
                return
            }
            // A harmless, read-only probe for Chrome extension diagnostics.
            if requestLine == "GET /health HTTP/1.1" {
                self.respond(connection, code: 200, message: "OK",
                             body: "{\"ok\":true,\"app\":\"TokenDesk\"}")
                return
            }
            let isUsagePost = requestLine == "POST /ingest HTTP/1.1"
            let isTasksPost = requestLine == "POST /tasks HTTP/1.1"
            guard (isUsagePost || isTasksPost),
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
            guard let length = Int(contentLength), (1...65_536).contains(length) else {
                self.respond(connection, code: 400, message: "Invalid length"); return
            }
            let start = range.upperBound
            if collected.count - start < length {
                if isComplete || error != nil { self.respond(connection, code: 400, message: "Incomplete body") }
                else { self.receive(connection, buffer: collected) }
                return
            }
            let body = collected.subdata(in: start..<(start + length))
            guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
                self.respond(connection, code: 422, message: "Invalid JSON"); return
            }
            if isTasksPost {
                guard let snapshot = RunningTaskSnapshot.parse(obj) else {
                    self.respond(connection, code: 422, message: "Invalid tasks"); return
                }
                let taskHandler = self.onTasks
                DispatchQueue.main.async {
                    taskHandler(snapshot)
                }
            } else {
                guard let usage = BrowserUsage.parse(obj) else {
                    self.respond(connection, code: 422, message: "Invalid usage"); return
                }
                let usageHandler = self.onUsage
                DispatchQueue.main.async {
                    usageHandler(usage)
                }
            }
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
