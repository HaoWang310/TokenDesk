import Foundation

@main struct TestBrowserUsage {
    static func main() {
        let direct: [String: Any] = [
            "pageURL": "https://chatgpt.com/", "source": "network", "backgroundDirect": true,
            "fiveHourRemaining": 66, "weeklyRemaining": 95,
            "fiveHourResetsAt": 1_790_000_000, "weeklyResetsAt": 1_790_500_000,
            "availableResets": 3
        ]
        let usage = BrowserUsage.parse(direct)
        assert(usage?.source == .network)
        assert(usage?.mode == .backgroundDirect)
        assert(usage?.sourceLabel == "Chrome 后台主动查询")
        assert(usage?.snapshot.fiveHour?.remainingPercent == 66)
        assert(usage?.snapshot.weekly?.remainingPercent == 95)
        assert(usage?.snapshot.fiveHour?.resetsAt != nil)
        assert(usage?.snapshot.availableResets == 3)

        let pageNetwork: [String: Any] = [
            "pageURL": "https://chatgpt.com/settings/usage", "source": "network",
            "fiveHourRemaining": 65
        ]
        assert(BrowserUsage.parse(pageNetwork)?.mode == .pageNetwork)
        let dom: [String: Any] = [
            "pageURL": "https://chatgpt.com/settings/usage", "source": "dom",
            "weeklyRemaining": 94
        ]
        assert(BrowserUsage.parse(dom)?.mode == .pageDOM)

        assert(BrowserUsage.parse(["pageURL": "https://example.com", "weeklyRemaining": 95]) == nil)
        assert(BrowserUsage.parse(["pageURL": "https://chatgpt.com/settings/usage", "weeklyRemaining": 101]) == nil)
        assert(BrowserUsage.parse(["pageURL": "https://chatgpt.com/settings/usage", "fiveHourRemaining": 0]) != nil)
        print("PASS: Browser usage validation, precise source mode, reset timestamps")
    }
}
