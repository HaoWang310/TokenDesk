import Foundation

// Minimal quota models used by the Chrome -> TokenDesk bridge.
// TokenDesk v1.6.2 no longer contains any Codex CLI quota reader or local token-log reader.
struct QuotaWindow: Equatable {
    let remainingPercent: Int
    let resetsAt: Date?
    let windowDurationMinutes: Int?
}

struct QuotaSnapshot: Equatable {
    let fiveHour: QuotaWindow?
    let weekly: QuotaWindow?
    let availableResets: Int?
    let plan: String?
    let ordinaryUsageAllowed: Bool?
}
