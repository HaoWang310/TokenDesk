import Foundation

// Browser bridge receives only sanitized quota fields extracted from ChatGPT's
// first-party usage response (preferred) or from the visible usage UI (fallback).
// No cookies, passwords, chat content, bearer tokens, or request headers cross
// the browser -> TokenDesk bridge.
struct BrowserUsage: Equatable {
    enum Source: String, Equatable, Codable { case network, dom }
    enum Mode: String, Equatable, Codable {
        case backgroundDirect = "background-direct"
        case pageNetwork = "page-network"
        case pageDOM = "page-dom"
    }

    let snapshot: QuotaSnapshot
    let pageURL: String
    let observedAt: Date
    let source: Source
    let mode: Mode

    var sourceLabel: String {
        switch mode {
        case .backgroundDirect: return "Chrome 后台主动查询"
        case .pageNetwork: return "页面网络备用读取"
        case .pageDOM: return "页面 DOM 备用读取"
        }
    }

    static func parse(_ json: [String: Any]) -> BrowserUsage? {
        guard let page = json["pageURL"] as? String,
              let url = URL(string: page),
              url.scheme == "https",
              ["chatgpt.com", "chat.openai.com"].contains(url.host?.lowercased() ?? "")
        else { return nil }

        func resetDate(_ field: String) -> Date? {
            guard let number = json[field] as? NSNumber else { return nil }
            let stamp = number.doubleValue
            guard stamp > 0, stamp < 9_999_999_999 else { return nil }
            return Date(timeIntervalSince1970: stamp)
        }
        func window(_ field: String, _ minutes: Int, _ resetField: String) -> QuotaWindow? {
            guard let number = json[field] as? NSNumber else { return nil }
            let n = number.intValue
            guard Double(n) == number.doubleValue, (0...100).contains(n) else { return nil }
            return QuotaWindow(remainingPercent: n,
                               resetsAt: resetDate(resetField),
                               windowDurationMinutes: minutes)
        }
        let five = window("fiveHourRemaining", 300, "fiveHourResetsAt")
        let weekly = window("weeklyRemaining", 10_080, "weeklyResetsAt")
        guard five != nil || weekly != nil else { return nil }
        let resets: Int? = {
            guard let n = json["availableResets"] as? NSNumber else { return nil }
            let value = n.intValue
            return (Double(value) == n.doubleValue && (0...20).contains(value)) ? value : nil
        }()
        let source = Source(rawValue: (json["source"] as? String) ?? "") ?? .dom
        let direct = (json["backgroundDirect"] as? Bool) == true
        let mode: Mode = direct ? .backgroundDirect : (source == .network ? .pageNetwork : .pageDOM)
        return BrowserUsage(snapshot: QuotaSnapshot(fiveHour: five, weekly: weekly,
                                                     availableResets: resets, plan: nil,
                                                     ordinaryUsageAllowed: nil),
                            pageURL: page, observedAt: Date(), source: source, mode: mode)
    }
}
