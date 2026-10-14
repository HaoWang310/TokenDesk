import AppKit
import SwiftUI
import Combine
import UserNotifications

// TokenDesk v1.7.7 monitors quota, running ChatGPT web tasks, and quota alerts.
// Data path: Chrome extension -> loopback BrowserBridge -> quota history + live task state.
// There is no Codex CLI process launch, ~/.codex log scan, token accounting,
// Admin Usage API key, or background Codex polling in this build.

private struct QuotaHistoryPoint: Codable, Equatable, Identifiable {
    let timestamp: Date
    let fiveHourRemaining: Int?
    let weeklyRemaining: Int?
    let availableResets: Int?

    var id: TimeInterval { timestamp.timeIntervalSince1970 }
}

private enum QuotaHistoryStore {
    static let key = "TokenDeskQuotaHistory_v1"
    static let retention: TimeInterval = 7 * 24 * 60 * 60

    static func load(now: Date = Date()) -> [QuotaHistoryPoint] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let decoded = try? JSONDecoder().decode([QuotaHistoryPoint].self, from: data) else { return [] }
        let cutoff = now.addingTimeInterval(-retention)
        return decoded.filter { $0.timestamp >= cutoff }.sorted { $0.timestamp < $1.timestamp }
    }

    static func save(_ points: [QuotaHistoryPoint]) {
        guard let data = try? JSONEncoder().encode(points) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

// Persist only sanitized quota values so the menu can immediately show the
// previous reading after a Mac/App restart. Login credentials never enter this cache.
private struct LastQuotaCache: Codable {
    let observedAt: Date
    let pageURL: String
    let source: BrowserUsage.Source
    let mode: BrowserUsage.Mode
    let fiveHourRemaining: Int?
    let fiveHourResetsAt: Date?
    let weeklyRemaining: Int?
    let weeklyResetsAt: Date?
    let availableResets: Int?

    static let key = "TokenDeskLastQuota_v1"

    init(_ usage: BrowserUsage) {
        observedAt = usage.observedAt
        pageURL = usage.pageURL
        source = usage.source
        mode = usage.mode
        fiveHourRemaining = usage.snapshot.fiveHour?.remainingPercent
        fiveHourResetsAt = usage.snapshot.fiveHour?.resetsAt
        weeklyRemaining = usage.snapshot.weekly?.remainingPercent
        weeklyResetsAt = usage.snapshot.weekly?.resetsAt
        availableResets = usage.snapshot.availableResets
    }

    func asUsage(now: Date = Date()) -> BrowserUsage? {
        // Do not resurrect arbitrarily old account data. Seven days matches the
        // history retention window and keeps startup state predictable.
        guard now.timeIntervalSince(observedAt) >= 0,
              now.timeIntervalSince(observedAt) <= QuotaHistoryStore.retention else { return nil }
        let five = fiveHourRemaining.map {
            QuotaWindow(remainingPercent: $0, resetsAt: fiveHourResetsAt, windowDurationMinutes: 300)
        }
        let week = weeklyRemaining.map {
            QuotaWindow(remainingPercent: $0, resetsAt: weeklyResetsAt, windowDurationMinutes: 10_080)
        }
        guard five != nil || week != nil else { return nil }
        return BrowserUsage(snapshot: QuotaSnapshot(fiveHour: five, weekly: week,
                                                     availableResets: availableResets,
                                                     plan: nil, ordinaryUsageAllowed: nil),
                            pageURL: pageURL, observedAt: observedAt, source: source, mode: mode)
    }

    static func load() -> BrowserUsage? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let value = try? JSONDecoder().decode(LastQuotaCache.self, from: data) else { return nil }
        return value.asUsage()
    }

    static func save(_ usage: BrowserUsage) {
        guard let data = try? JSONEncoder().encode(LastQuotaCache(usage)) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

private final class QuotaAlertManager {
    static let shared = QuotaAlertManager()
    static let threshold = 20

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard

    private init() {}

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func process(_ snapshot: QuotaSnapshot, now: Date = Date()) {
        processWindow(kind: "five",
                      label: "5小时",
                      window: snapshot.fiveHour,
                      now: now)
        processWindow(kind: "weekly",
                      label: "每周",
                      window: snapshot.weekly,
                      now: now)
    }

    private func processWindow(kind: String, label: String, window: QuotaWindow?, now: Date) {
        guard let window = window else { return }

        let cycleKey: String
        if let reset = window.resetsAt {
            cycleKey = String(Int(reset.timeIntervalSince1970))
            scheduleReset(kind: kind, label: label, at: reset, now: now)
        } else {
            let duration = max(60, (window.windowDurationMinutes ?? 300) * 60)
            cycleKey = "fallback-" + String(Int(now.timeIntervalSince1970) / duration)
        }

        let lowKey = "TokenDeskAlertLowCycle_" + kind
        if window.remainingPercent <= Self.threshold &&
           defaults.string(forKey: lowKey) != cycleKey {
            let resetText = window.resetsAt.map {
                "，预计 " + DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short) + " 刷新"
            } ?? ""
            notify(identifier: "tokendesk.low." + kind + "." + cycleKey,
                   title: "TokenDesk · " + label + "额度剩余20%或以下",
                   body: "当前剩余 " + String(window.remainingPercent) + "%" + resetText + "。")
            defaults.set(cycleKey, forKey: lowKey)
        }
    }

    private func scheduleReset(kind: String, label: String, at date: Date, now: Date) {
        let identifier = "tokendesk.reset." + kind
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        guard date.timeIntervalSince(now) > 2 else { return }

        let content = UNMutableNotificationContent()
        content.title = "TokenDesk · " + label + "额度已刷新"
        content.body = "新的" + label + "额度周期已经开始。"
        content.sound = .default

        let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
    }

    private func notify(identifier: String, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
}

@MainActor
private final class TokenModel: ObservableObject {
    @Published var browserUsage: BrowserUsage?
    @Published var browserBridgeState: String = "等待 Chrome 后台连接"
    @Published var quotaHistory: [QuotaHistoryPoint] = []
    @Published var runningTasks: [RunningChatTask] = []
    @Published var usageDays: [DailyUsageStat] = []
    @Published private var taskSnapshotAt: Date?
    @Published var panelHeight: CGFloat = 700
    @Published var showSettings = false
    @Published private var freshnessClock = Date()
    @Published private var liveReadingReceived = false
    @Published var pinned = true {
        didSet { UserDefaults.standard.set(pinned, forKey: "pinned") }
    }
    @Published var opacity: Double = 0.97 {
        didSet { UserDefaults.standard.set(opacity, forKey: "opacity") }
    }

    init() {
        if UserDefaults.standard.object(forKey: "pinned") != nil {
            pinned = UserDefaults.standard.bool(forKey: "pinned")
        }
        if UserDefaults.standard.object(forKey: "opacity") != nil {
            opacity = max(0.60, min(1.0, UserDefaults.standard.double(forKey: "opacity")))
        }
        quotaHistory = QuotaHistoryStore.load()
        browserUsage = LastQuotaCache.load()
        // v1.6.1 already stored quota history but did not have LastQuotaCache.
        // On the first v1.6.2 launch, migrate the newest history point so the
        // menu does not fall back to dashes while waiting for Chrome.
        if browserUsage == nil, let last = quotaHistory.last {
            let five = last.fiveHourRemaining.map {
                QuotaWindow(remainingPercent: $0, resetsAt: nil, windowDurationMinutes: 300)
            }
            let week = last.weeklyRemaining.map {
                QuotaWindow(remainingPercent: $0, resetsAt: nil, windowDurationMinutes: 10_080)
            }
            if five != nil || week != nil {
                browserUsage = BrowserUsage(
                    snapshot: QuotaSnapshot(fiveHour: five, weekly: week,
                                            availableResets: last.availableResets,
                                            plan: nil, ordinaryUsageAllowed: nil),
                    pageURL: "https://chatgpt.com/", observedAt: last.timestamp,
                    source: .network, mode: .backgroundDirect)
            }
        }
        if browserUsage != nil {
            browserBridgeState = "已载入上次额度，等待 Chrome 后台更新"
        }
    }

    func refreshFreshnessClock(_ date: Date = Date()) {
        freshnessClock = date
        if let taskSnapshotAt = taskSnapshotAt, date.timeIntervalSince(taskSnapshotAt) > 75, !runningTasks.isEmpty {
            runningTasks = []
        }
    }

    var runningTaskCount: Int { runningTasks.count }
    var thinkingTaskCount: Int { runningTasks.filter { $0.phase == .thinking }.count }
    var workingTaskCount: Int { runningTasks.filter { $0.phase == .working }.count }

    var runningTaskSummary: String {
        var parts: [String] = []
        if thinkingTaskCount > 0 { parts.append("思考 \(thinkingTaskCount)") }
        if workingTaskCount > 0 { parts.append("工作 \(workingTaskCount)") }
        return parts.isEmpty ? "任务 0" : parts.joined(separator: " · ")
    }

    func receivedTaskSnapshot(_ value: RunningTaskSnapshot) {
        taskSnapshotAt = value.observedAt
        runningTasks = value.tasks
        usageDays = value.usageDays
    }

    var browserIsFresh: Bool {
        guard liveReadingReceived, let browserUsage = browserUsage else { return false }
        let age = freshnessClock.timeIntervalSince(browserUsage.observedAt)
        return age >= 0 && age <= 90
    }

    var activeQuota: QuotaSnapshot? { browserUsage?.snapshot }
    var activeQuotaIsStale: Bool { browserUsage != nil && !browserIsFresh }

    var activeQuotaSource: String {
        guard let browserUsage = browserUsage else { return "未读取到额度（请检查 Chrome 扩展连接）" }
        let time = browserUsage.observedAt.formatted(date: .omitted, time: .standard)
        if browserIsFresh {
            return "🌐 \(browserUsage.sourceLabel) · \(time)"
        }
        return "⚠ 上次额度 · \(browserUsage.sourceLabel) · \(time)（等待 Chrome 更新）"
    }

    func receivedBrowserUsage(_ value: BrowserUsage) {
        browserUsage = value
        liveReadingReceived = true
        freshnessClock = Date()
        LastQuotaCache.save(value)
        recordQuotaHistory(value.snapshot, at: value.observedAt)
        QuotaAlertManager.shared.process(value.snapshot, now: value.observedAt)
        browserBridgeState = "已读取\(value.sourceLabel)数据：" + value.observedAt.formatted(date: .omitted, time: .standard)
    }

    private func recordQuotaHistory(_ snapshot: QuotaSnapshot, at date: Date) {
        let point = QuotaHistoryPoint(timestamp: date,
                                      fiveHourRemaining: snapshot.fiveHour?.remainingPercent,
                                      weeklyRemaining: snapshot.weekly?.remainingPercent,
                                      availableResets: snapshot.availableResets)
        guard point.fiveHourRemaining != nil || point.weeklyRemaining != nil else { return }
        let cutoff = date.addingTimeInterval(-QuotaHistoryStore.retention)
        var values = quotaHistory.filter { $0.timestamp >= cutoff }
        if let last = values.last {
            let same = last.fiveHourRemaining == point.fiveHourRemaining &&
                       last.weeklyRemaining == point.weeklyRemaining &&
                       last.availableResets == point.availableResets
            if same && date.timeIntervalSince(last.timestamp) < 300 { return }
        }
        values.append(point)
        if values.count > 2200 { values.removeFirst(values.count - 2200) }
        quotaHistory = values
        QuotaHistoryStore.save(values)
    }

    var quotaHistory24h: [QuotaHistoryPoint] {
        let cutoff = freshnessClock.addingTimeInterval(-24 * 60 * 60)
        return quotaHistory.filter { $0.timestamp >= cutoff }
    }

    var fiveHourMinimum24h: Int? { quotaHistory24h.compactMap(\.fiveHourRemaining).min() }
    var weeklyMinimum24h: Int? { quotaHistory24h.compactMap(\.weeklyRemaining).min() }
}

private struct QuotaHistoryChart: View {
    let points: [QuotaHistoryPoint]
    let startDate: Date
    let endDate: Date

    private let fiveColor = Color(red: 0.42, green: 0.88, blue: 0.75)
    private let weekColor = Color(red: 0.54, green: 0.69, blue: 1.00)

    private var span: TimeInterval {
        max(60, endDate.timeIntervalSince(startDate))
    }

    private func pointPosition(size: CGSize, point: QuotaHistoryPoint, raw: Int) -> CGPoint {
        let percent = min(100, max(0, raw))
        let elapsed = point.timestamp.timeIntervalSince(startDate)
        let ratio = min(1, max(0, elapsed / span))
        let x = size.width * CGFloat(ratio)
        let y = size.height * (1 - CGFloat(percent) / 100)
        return CGPoint(x: x, y: y)
    }

    private func chartPath(size: CGSize, value: (QuotaHistoryPoint) -> Int?) -> Path {
        var path = Path()
        var drawing = false
        for point in points {
            guard point.timestamp >= startDate && point.timestamp <= endDate,
                  let raw = value(point) else {
                drawing = false
                continue
            }
            let p = pointPosition(size: size, point: point, raw: raw)
            if drawing { path.addLine(to: p) } else { path.move(to: p); drawing = true }
        }
        return path
    }

    var body: some View {
        GeometryReader { geo in
            let dotStride = max(1, points.count / 48)
            ZStack {
                ForEach([0.25, 0.5, 0.75], id: \.self) { fraction in
                    Path { p in
                        let y = geo.size.height * CGFloat(fraction)
                        p.move(to: CGPoint(x: 0, y: y))
                        p.addLine(to: CGPoint(x: geo.size.width, y: y))
                    }
                    .stroke(Color.white.opacity(0.07), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
                }

                chartPath(size: geo.size, value: { $0.weeklyRemaining })
                    .stroke(weekColor, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                chartPath(size: geo.size, value: { $0.fiveHourRemaining })
                    .stroke(fiveColor, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))

                ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                    if (index % dotStride == 0 || index == points.count - 1),
                       point.timestamp >= startDate, point.timestamp <= endDate {
                        if let raw = point.weeklyRemaining {
                            let p = pointPosition(size: geo.size, point: point, raw: raw)
                            Circle().fill(weekColor).frame(width: 4, height: 4).position(p)
                        }
                        if let raw = point.fiveHourRemaining {
                            let p = pointPosition(size: geo.size, point: point, raw: raw)
                            Circle().fill(fiveColor).frame(width: 4.5, height: 4.5).position(p)
                        }
                    }
                }

                if points.count < 2 {
                    Text(points.isEmpty ? "等待后台同步后开始记录" : "已记录第一个额度点")
                        .font(.system(size: 10))
                        .foregroundColor(.white.opacity(0.35))
                }
            }
        }
    }
}

private struct QuotaHistorySection: View {
    let points: [QuotaHistoryPoint]
    let points24h: [QuotaHistoryPoint]
    let fiveHourMinimum24h: Int?
    let weeklyMinimum24h: Int?

    private var chartEnd: Date { Date() }

    private var chartWindow: TimeInterval {
        guard let first = points24h.first?.timestamp else { return 30 * 60 }
        let observed = max(0, chartEnd.timeIntervalSince(first))
        if observed >= 23.5 * 60 * 60 { return 24 * 60 * 60 }
        if observed < 60 * 60 { return min(24 * 60 * 60, max(30 * 60, observed * 1.12)) }
        return min(24 * 60 * 60, max(60 * 60, observed * 1.05))
    }

    private var chartStart: Date { chartEnd.addingTimeInterval(-chartWindow) }

    private var chartTitle: String {
        if chartWindow >= 23.5 * 60 * 60 { return "最近 24 小时" }
        if chartWindow >= 60 * 60 {
            return "最近 \(max(1, Int(ceil(chartWindow / 3600)))) 小时"
        }
        return "最近 \(max(1, Int(ceil(chartWindow / 60)))) 分钟"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            metrics
            chartCard
            recordsCard
            footer
        }
    }

    private var header: some View {
        HStack {
            Text("额度历史")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white.opacity(0.78))
            Spacer()
            Text("本机记录 · 最近 7 天")
                .font(.system(size: 9.5))
                .foregroundColor(.white.opacity(0.38))
        }
    }

    private var metrics: some View {
        HStack(spacing: 9) {
            metricCard(title: "24h · 5h 最低", value: fiveHourMinimum24h)
            metricCard(title: "24h · 周最低", value: weeklyMinimum24h)
        }
    }

    private var chartCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(chartTitle)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(.white.opacity(0.56))
                Spacer()
                legend(color: Color(red: 0.42, green: 0.88, blue: 0.75), text: "5h")
                legend(color: Color(red: 0.54, green: 0.69, blue: 1.00), text: "每周")
            }
            QuotaHistoryChart(points: points24h, startDate: chartStart, endDate: chartEnd)
                .frame(height: 118)
            HStack {
                Text(chartStart.formatted(date: .omitted, time: .shortened))
                Spacer()
                Text("现在")
            }
            .font(.system(size: 9, design: .monospaced))
            .foregroundColor(.white.opacity(0.30))
        }
        .padding(12)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
    }

    private var recordsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("最近记录")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(.white.opacity(0.56))
                Spacer()
                Text("额度变化立即记录")
                    .font(.system(size: 9.5))
                    .foregroundColor(.white.opacity(0.32))
            }
            recordsBody
        }
        .padding(12)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var recordsBody: some View {
        if points.isEmpty {
            Text("暂无历史。后台额度首次同步后会从这里开始记录。")
                .font(.system(size: 10.5))
                .foregroundColor(.white.opacity(0.45))
                .padding(.vertical, 8)
        } else {
            ForEach(recentPoints) { point in
                recordRow(point)
            }
        }
    }

    private var recentPoints: [QuotaHistoryPoint] {
        Array(points.suffix(4).reversed())
    }

    private var footer: some View {
        Text("历史数据只保存在这台 Mac，最多保留 7 天。")
            .font(.system(size: 9.5))
            .foregroundColor(.white.opacity(0.35))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func recordRow(_ point: QuotaHistoryPoint) -> some View {
        HStack(spacing: 8) {
            Text(point.timestamp.formatted(date: .omitted, time: .shortened))
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.white.opacity(0.42))
                .frame(width: 58, alignment: .leading)
            Text("5h \(percentText(point.fiveHourRemaining))")
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundColor(.white.opacity(0.78))
            Spacer()
            Text("周 \(percentText(point.weeklyRemaining))")
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundColor(.white.opacity(0.78))
        }
    }

    private func percentText(_ value: Int?) -> String {
        guard let value = value else { return "—" }
        return "\(value)%"
    }

    private func metricCard(title: String, value: Int?) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.system(size: 10.5))
                .foregroundColor(.white.opacity(0.5))
            Text(percentText(value))
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundColor(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
    }

    private func legend(color: Color, text: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
                .font(.system(size: 9.5))
                .foregroundColor(.white.opacity(0.48))
        }
    }
}

private struct TokenDeskHeader: View {
    @ObservedObject var model: TokenModel
    let hideWindow: () -> Void

    private var statusColor: Color {
        if model.browserIsFresh { return .green }
        return model.browserUsage == nil ? .gray : .orange
    }

    private var statusText: String {
        if model.browserIsFresh { return "已连接" }
        return model.browserUsage == nil ? "未连接" : "数据过期"
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "circle.hexagongrid.fill")
                .font(.system(size: 19, weight: .medium))
                .foregroundColor(Color(red: 0.47, green: 0.95, blue: 0.80))
            Text("TOKEN DESK")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .tracking(2.1)
                .foregroundColor(.white)
            Spacer()
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(statusText)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.white.opacity(0.7))
            Button(action: { model.showSettings.toggle() }) {
                Image(systemName: model.showSettings ? "chart.bar.xaxis" : "gearshape")
            }
            .buttonStyle(.plain)
            .help(model.showSettings ? "返回额度" : "设置")
            .padding(.leading, 7)
            Button(action: hideWindow) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
            }
            .buttonStyle(.plain)
            .padding(.leading, 3)
            .help("隐藏窗口（可从菜单栏重新显示）")
        }
        .foregroundColor(.white.opacity(0.72))
        .padding(.bottom, 18)
    }
}

private struct QuotaBarRow: View {
    let title: String
    let window: QuotaWindow?

    private var remaining: Int { window?.remainingPercent ?? 0 }

    private var barColor: Color {
        if remaining <= 10 { return .red }
        if remaining <= 20 { return .orange }
        return Color(red: 0.42, green: 0.88, blue: 0.75)
    }

    private var percentLabel: String {
        guard let value = window?.remainingPercent else { return "—" }
        return "\(value)%"
    }

    private var resetLabel: String? {
        guard let reset = window?.resetsAt else { return nil }
        return reset.formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(title)
                    .foregroundColor(.white.opacity(0.72))
                Spacer()
                Text(percentLabel)
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .foregroundColor(window == nil ? .gray : barColor)
                if let resetLabel = resetLabel {
                    Text(resetLabel)
                        .foregroundColor(.white.opacity(0.45))
                        .lineLimit(1)
                }
            }
            .font(.system(size: 11))
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.white.opacity(0.08))
                    RoundedRectangle(cornerRadius: 4)
                        .fill(barColor)
                        .frame(width: geometry.size.width * CGFloat(remaining) / 100.0)
                }
            }
            .frame(height: 6)
        }
    }
}

private struct QuotaSummaryCard: View {
    let snapshot: QuotaSnapshot?
    let sourceText: String
    let isStale: Bool

    private var resetCountText: String {
        guard let count = snapshot?.availableResets else { return "可用重置：—" }
        return "可用重置：\(count) 次"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("CHATGPT 网页额度")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.2)
                    .foregroundColor(.white.opacity(0.64))
                Spacer()
                if isStale && snapshot != nil {
                    Text("旧数据")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(.orange)
                }
            }
            QuotaBarRow(title: "5 小时", window: snapshot?.fiveHour)
            QuotaBarRow(title: "每周", window: snapshot?.weekly)
            HStack(spacing: 6) {
                Text(resetCountText)
                Spacer()
                Text(sourceText)
                    .lineLimit(2)
                    .multilineTextAlignment(.trailing)
            }
            .font(.system(size: 10))
            .foregroundColor(.white.opacity(0.48))
        }
        .padding(13)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct RunningTasksSection: View {
    let tasks: [RunningChatTask]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("运行任务")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.78))
                Spacer()
                Text(taskSummary)
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .foregroundColor(tasks.isEmpty ? .white.opacity(0.38) : Color(red: 0.42, green: 0.88, blue: 0.75))
            }

            if tasks.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle")
                        .foregroundColor(.white.opacity(0.38))
                    Text("当前没有检测到正在运行的 ChatGPT 网页任务")
                        .font(.system(size: 10.5))
                        .foregroundColor(.white.opacity(0.42))
                    Spacer()
                }
                .padding(12)
                .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            } else {
                VStack(spacing: 7) {
                    ForEach(tasks.prefix(8)) { task in
                        taskRow(task)
                    }
                }
            }
        }
    }

    private var taskSummary: String {
        let thinking = tasks.filter { $0.phase == .thinking }.count
        let working = tasks.filter { $0.phase == .working }.count
        var parts: [String] = []
        if thinking > 0 { parts.append("思考 \(thinking)") }
        if working > 0 { parts.append("工作 \(working)") }
        return parts.isEmpty ? "0" : parts.joined(separator: " · ")
    }

    private func taskRow(_ task: RunningChatTask) -> some View {
        Button {
            if let url = URL(string: task.pageURL) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                    .tint(task.phase == .thinking ? Color(red: 0.54, green: 0.69, blue: 1.00) : Color(red: 0.42, green: 0.88, blue: 0.75))
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(task.title)
                            .font(.system(size: 10.8, weight: .medium))
                            .foregroundColor(.white.opacity(0.86))
                            .lineLimit(1)
                        Text(task.phase == .thinking ? "思考" : "工作")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(task.phase == .thinking ? Color(red: 0.64, green: 0.77, blue: 1.00) : Color(red: 0.50, green: 0.94, blue: 0.80))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.white.opacity(0.055), in: Capsule())
                        if let modelName = task.modelName {
                            Text(modelName)
                                .font(.system(size: 8.5, weight: .medium))
                                .foregroundColor(Color(red: 0.72, green: 0.78, blue: 1.00))
                                .lineLimit(1)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.white.opacity(0.045), in: Capsule())
                        }
                    }
                    Text("已运行 " + elapsed(task.startedAt))
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundColor(.white.opacity(0.38))
                }
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.white.opacity(0.28))
            }
            .padding(10)
            .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
        }
        .buttonStyle(.plain)
    }

    private func elapsed(_ start: Date) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)秒" }
        if seconds < 3600 { return "\(seconds / 60)分\(seconds % 60)秒" }
        return "\(seconds / 3600)时\((seconds % 3600) / 60)分"
    }
}


private struct WeeklyUsageSection: View {
    let days: [DailyUsageStat]

    private var today: DailyUsageStat? { days.last }
    private var totalSeconds: Int { days.reduce(0) { $0 + $1.activeSeconds } }
    private var totalQuota: Int { days.reduce(0) { $0 + $1.weeklyQuotaUsed } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("近 7 天使用统计")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.78))
                Spacer()
                Text("Chrome 本机记录")
                    .font(.system(size: 9.5))
                    .foregroundColor(.white.opacity(0.38))
            }

            HStack(spacing: 9) {
                metric(title: "今天使用时间", value: durationText(today?.activeSeconds ?? 0))
                metric(title: "7 天累计", value: durationText(totalSeconds))
            }

            barCard(title: "每日使用时间",
                    values: days.map { Double($0.activeSeconds) },
                    labels: days.map { dayLabel($0.day) },
                    valueText: { durationText(Int($0)) })

            barCard(title: "每日用量",
                    values: days.map { Double($0.weeklyQuotaUsed) },
                    labels: days.map { dayLabel($0.day) },
                    valueText: { "\(Int($0))%" })

            Text("“使用时间”= ChatGPT 标签页位于前台且最近 5 分钟内有交互的时间；多个标签页不会重复累计。“每日用量”= 每周剩余额度当日下降的百分点，不是 Token 数。7 天用量累计：\(totalQuota)%。")
                .font(.system(size: 9.2))
                .foregroundColor(.white.opacity(0.38))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func metric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 9.5))
                .foregroundColor(.white.opacity(0.46))
            Text(value)
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundColor(.white.opacity(0.9))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
    }

    private func barCard(title: String,
                         values: [Double],
                         labels: [String],
                         valueText: @escaping (Double) -> String) -> some View {
        let maximum = max(1.0, values.max() ?? 0)
        return VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(.white.opacity(0.56))

            if values.isEmpty {
                Text("更新扩展后开始记录")
                    .font(.system(size: 10))
                    .foregroundColor(.white.opacity(0.36))
                    .frame(maxWidth: .infinity, minHeight: 82)
            } else {
                HStack(alignment: .bottom, spacing: 5) {
                    ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                        VStack(spacing: 4) {
                            Text(valueText(value))
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundColor(.white.opacity(0.42))
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            GeometryReader { geo in
                                VStack(spacing: 0) {
                                    Spacer(minLength: 0)
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(Color(red: 0.42, green: 0.88, blue: 0.75).opacity(value > 0 ? 0.88 : 0.18))
                                        .frame(height: max(2, geo.size.height * CGFloat(value / maximum)))
                                }
                            }
                            .frame(height: 62)
                            Text(index < labels.count ? labels[index] : "")
                                .font(.system(size: 7.5, design: .monospaced))
                                .foregroundColor(.white.opacity(0.32))
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .padding(11)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
    }

    private func durationText(_ seconds: Int) -> String {
        let minutes = max(0, seconds) / 60
        if minutes < 60 { return "\(minutes)分" }
        return "\(minutes / 60)时\(minutes % 60)分"
    }

    private func dayLabel(_ value: String) -> String {
        let parts = value.split(separator: "-")
        guard parts.count == 3 else { return value }
        return "\(Int(parts[1]) ?? 0)/\(Int(parts[2]) ?? 0)"
    }
}

private struct TokenDeskSettingsView: View {
    @ObservedObject var model: TokenModel
    let setPinned: (Bool) -> Void
    let setOpacity: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("显示设置")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.white)
            Toggle("始终置顶", isOn: $model.pinned)
                .onChange(of: model.pinned) { value in setPinned(value) }
                .font(.system(size: 12))
                .tint(Color(red: 0.44, green: 0.90, blue: 0.76))
            opacityControl
            Divider().overlay(Color.white.opacity(0.1))
            browserSettings
            Divider().overlay(Color.white.opacity(0.1))
            historySettings
        }
        .foregroundColor(.white)
    }

    private var opacityControl: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("透明度")
                    .font(.system(size: 12))
                Spacer()
                Text("\(Int(model.opacity * 100))%")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.white.opacity(0.54))
            }
            Slider(value: $model.opacity, in: 0.60...1.0)
                .onChange(of: model.opacity) { value in setOpacity(value) }
                .tint(Color(red: 0.44, green: 0.90, blue: 0.76))
        }
    }

    private var browserSettings: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("网页端额度读取（Chrome）")
                .font(.system(size: 13, weight: .semibold))
            Text("TokenDesk 只通过 Chrome 扩展读取 ChatGPT 剩余额度。只要 Chrome 正在运行并保持 ChatGPT 登录，就不需要打开 ChatGPT 或“设置 → 用量”页面。登录会话只在 Chrome 内使用，不把 Cookie、密码、访问令牌或聊天内容发送给 TokenDesk。")
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.6))
                .fixedSize(horizontal: false, vertical: true)
            pairingRow
            Text("网页端监听：" + model.browserBridgeState)
                .font(.system(size: 10))
                .foregroundColor(.white.opacity(0.6))
            Button("打开 ChatGPT 网页用量（仅诊断） ↗") {
                if let url = URL(string: "https://chatgpt.com/settings/usage") {
                    NSWorkspace.shared.open(url)
                }
            }
            .buttonStyle(.link)
            Text("设置顺序：① Chrome 加载扩展 ② 保存配对码 ③ 测试本机连接。之后 Chrome 保持运行且仍登录 ChatGPT 即可，扩展约每 30 秒后台主动查询。")
                .font(.system(size: 10.5))
                .foregroundColor(.white.opacity(0.43))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var pairingRow: some View {
        HStack {
            Text("配对码：" + BrowserBridge.pairingCode.prefix(10) + "…")
                .font(.system(size: 11, design: .monospaced))
            Spacer()
            Button("复制配对码") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(BrowserBridge.pairingCode, forType: .string)
            }
            .buttonStyle(.bordered)
        }
    }

    private var historySettings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("额度历史")
                .font(.system(size: 13, weight: .semibold))
            Text("只记录 5 小时 / 每周剩余额度、重置次数和时间，不统计 Token。历史只保存在本机，最多 7 天；额度变化立即记录，相同读数最多每 5 分钟保存一个点。")
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.58))
                .fixedSize(horizontal: false, vertical: true)
            Text("v1.7.7 新增额度提醒：5小时/每周剩余20%或以下提醒，并在对应额度刷新时发送系统通知。")
                .font(.system(size: 10.5))
                .foregroundColor(.white.opacity(0.43))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct TokenDeskScrollContent: View {
    @ObservedObject var model: TokenModel
    let setPinned: (Bool) -> Void
    let setOpacity: (Double) -> Void

    var body: some View {
        ScrollView(.vertical) {
            Group {
                if model.showSettings {
                    TokenDeskSettingsView(model: model, setPinned: setPinned, setOpacity: setOpacity)
                } else {
                    quotaAndHistory
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 8)
        }
    }

    private var quotaAndHistory: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuotaSummaryCard(snapshot: model.activeQuota,
                             sourceText: model.activeQuotaSource,
                             isStale: model.activeQuotaIsStale)
                .padding(.bottom, 15)
            RunningTasksSection(tasks: model.runningTasks)
                .padding(.bottom, 15)
            WeeklyUsageSection(days: model.usageDays)
                .padding(.bottom, 15)
            QuotaHistorySection(points: model.quotaHistory,
                                points24h: model.quotaHistory24h,
                                fiveHourMinimum24h: model.fiveHourMinimum24h,
                                weeklyMinimum24h: model.weeklyMinimum24h)
        }
    }
}

private struct TokenDeskFooter: View {
    let text: String

    var body: some View {
        VStack(spacing: 12) {
            Rectangle()
                .fill(Color.white.opacity(0.10))
                .frame(height: 1)
            HStack(spacing: 8) {
                Image(systemName: "info.circle")
                    .foregroundColor(.white.opacity(0.44))
                Text(text)
                    .foregroundColor(.white.opacity(0.5))
                    .lineLimit(2)
                    .font(.system(size: 10.5))
                Spacer(minLength: 3)
            }
            .frame(minHeight: 28)
        }
    }
}

private struct TokenDeskView: View {
    @ObservedObject var model: TokenModel
    let hideWindow: () -> Void
    let setPinned: (Bool) -> Void
    let setOpacity: (Double) -> Void

    private var footerText: String {
        model.showSettings ? model.browserBridgeState : model.activeQuotaSource
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TokenDeskHeader(model: model, hideWindow: hideWindow)
            TokenDeskScrollContent(model: model, setPinned: setPinned, setOpacity: setOpacity)
            TokenDeskFooter(text: footerText)
        }
        .padding(20)
        .frame(width: 360, height: model.panelHeight, alignment: .topLeading)
        .background(panelBackground)
        .clipShape(RoundedRectangle(cornerRadius: 21, style: .continuous))
        .preferredColorScheme(.dark)
    }

    private var panelBackground: some View {
        RoundedRectangle(cornerRadius: 21, style: .continuous)
            .fill(Color(red: 0.058, green: 0.080, blue: 0.126).opacity(0.97))
            .overlay(
                RoundedRectangle(cornerRadius: 21, style: .continuous)
                    .stroke(Color.white.opacity(0.16), lineWidth: 1)
            )
    }
}

private final class DesktopPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

@MainActor
private final class TokenDeskDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private let model = TokenModel()
    private var freshnessTimer: Timer?
    private var panel: DesktopPanel!
    private var status: NSStatusItem!
    private var quotaObserver: AnyCancellable?
    private var fiveHourItem: NSMenuItem!
    private var weeklyItem: NSMenuItem!
    private var resetsItem: NSMenuItem!
    private var quotaStateItem: NSMenuItem!
    private var taskCountItem: NSMenuItem!
    private var browserBridge: BrowserBridge?
    private let panelWidth: CGFloat = 360
    private let maximumPanelHeight: CGFloat = 740

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        UNUserNotificationCenter.current().delegate = self
        QuotaAlertManager.shared.requestAuthorization()
        let startupFrame = resolvedPanelFrame(restorePosition: true)
        model.panelHeight = startupFrame.height
        panel = DesktopPanel(contentRect: startupFrame,
                             styleMask: [.titled, .fullSizeContentView],
                             backing: .buffered, defer: false)
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.title = "Token Desk"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.level = model.pinned ? .floating : .normal
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.alphaValue = model.opacity
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.contentView = NSHostingView(rootView: TokenDeskView(
            model: model,
            hideWindow: { [weak self] in self?.hidePanel() },
            setPinned: { [weak self] value in
                self?.panel.level = value ? .floating : .normal
            },
            setOpacity: { [weak self] value in self?.panel.alphaValue = value }
        ))

        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = makeTokenDeskMenuBarIcon()
        status.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        fiveHourItem = NSMenuItem(title: "5 小时额度：—", action: nil, keyEquivalent: "")
        weeklyItem = NSMenuItem(title: "每周额度：—", action: nil, keyEquivalent: "")
        resetsItem = NSMenuItem(title: "可用重置：—", action: nil, keyEquivalent: "")
        quotaStateItem = NSMenuItem(title: "额度未连接", action: nil, keyEquivalent: "")
        taskCountItem = NSMenuItem(title: "运行任务：0", action: nil, keyEquivalent: "")
        [fiveHourItem!, weeklyItem!, resetsItem!, taskCountItem!, quotaStateItem!].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(withTitle: "显示 / 隐藏面板", action: #selector(togglePanel), keyEquivalent: "")
        menu.addItem(withTitle: "重置面板位置并显示", action: #selector(resetPanelLocation), keyEquivalent: "")
        menu.addItem(withTitle: "连接 / 设置", action: #selector(showSettings), keyEquivalent: "")
        menu.addItem(withTitle: "复制网页扩展配对码", action: #selector(copyBrowserPairingCode), keyEquivalent: "")
        menu.addItem(withTitle: "打开网页扩展文件夹", action: #selector(openExtensionFolder), keyEquivalent: "")
        menu.addItem(withTitle: "打开 ChatGPT 网页用量（诊断）", action: #selector(openBrowserUsage), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Token Desk", action: #selector(quitApp), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        menu.delegate = self
        status.menu = menu

        quotaObserver = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.updateMenuBar() }
        }
        updateMenuBar()
        // Use an AppKit/Foundation timer owned by the application delegate instead of
        // Combine Timer.publish inside the @MainActor model. This avoids Swift 6
        // actor-isolation compile failures while keeping the 90-second stale state live.
        freshnessTimer = Timer(timeInterval: 10.0,
                               target: self,
                               selector: #selector(refreshFreshnessState),
                               userInfo: nil,
                               repeats: true)
        if let timer = freshnessTimer { RunLoop.main.add(timer, forMode: .common) }

        NotificationCenter.default.addObserver(self, selector: #selector(windowDidMove), name: NSWindow.didMoveNotification, object: panel)
        browserBridge = BrowserBridge(
            onUsage: { [weak self] reading in
                self?.model.receivedBrowserUsage(reading)
                self?.updateMenuBar()
            },
            onTasks: { [weak self] snapshot in
                self?.model.receivedTaskSnapshot(snapshot)
                self?.updateMenuBar()
            },
            onState: { [weak self] state in self?.model.browserBridgeState = state }
        )
        browserBridge?.start()
        panel.orderOut(nil)
    }

    @objc private func refreshFreshnessState() {
        model.refreshFreshnessClock()
        updateMenuBar()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    private func makeTokenDeskMenuBarIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.black.setFill()

        let dot: CGFloat = 3.2
        let radius: CGFloat = 4.6
        let center = NSPoint(x: 9, y: 9)
        let centers: [NSPoint] = [
            center,
            NSPoint(x: center.x, y: center.y + radius),
            NSPoint(x: center.x, y: center.y - radius),
            NSPoint(x: center.x + 4.0, y: center.y + 2.3),
            NSPoint(x: center.x + 4.0, y: center.y - 2.3),
            NSPoint(x: center.x - 4.0, y: center.y + 2.3),
            NSPoint(x: center.x - 4.0, y: center.y - 2.3)
        ]

        for point in centers {
            let rect = NSRect(x: point.x - dot / 2,
                              y: point.y - dot / 2,
                              width: dot,
                              height: dot)
            NSBezierPath(ovalIn: rect).fill()
        }
        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    private func updateMenuBar() {
        guard status != nil, fiveHourItem != nil else { return }
        let quota = model.activeQuota
        let five = quota?.fiveHour?.remainingPercent
        let week = quota?.weekly?.remainingPercent
        let f = five.map { "\($0)%" } ?? "—"
        let w = week.map { "\($0)%" } ?? "—"
        let critical = [five, week].compactMap { $0 }.contains { $0 <= 20 }
        let stale = model.activeQuotaIsStale
        let statusPrefix = stale ? "⚠ " : (model.browserIsFresh ? "🌐 " : "")
        status.button?.attributedTitle = NSAttributedString(
            string: "\(statusPrefix)5h \(f) · 周 \(w) · \(model.runningTaskSummary)",
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold),
                         .foregroundColor: stale || critical ? NSColor.systemOrange : NSColor.labelColor]
        )
        func line(_ prefix: String, _ window: QuotaWindow?) -> String {
            guard let window = window else { return "\(prefix)：—" }
            let time = window.resetsAt.map { " · 重置：" + $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
            return "\(prefix)：\(window.remainingPercent)%\(time)"
        }
        fiveHourItem.title = line("5 小时剩余", quota?.fiveHour)
        weeklyItem.title = line("每周剩余", quota?.weekly)
        resetsItem.title = quota?.availableResets.map { "可用重置：\($0) 次" } ?? "可用重置：—"
        taskCountItem.title = "运行任务：\(model.runningTaskSummary)"
        quotaStateItem.title = model.activeQuotaSource
        status.button?.toolTip = "ChatGPT 剩余额度（非 Token） · " + model.activeQuotaSource
    }

    @objc private func windowDidMove(_ notification: Notification) {
        guard let panel = panel else { return }
        UserDefaults.standard.set(Double(panel.frame.origin.x), forKey: "windowX")
        UserDefaults.standard.set(Double(panel.frame.origin.y), forKey: "windowY")
    }

    private func preferredScreen() -> NSScreen? {
        status?.button?.window?.screen
            ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }

    private func panelHeight(for screen: NSScreen) -> CGFloat {
        min(maximumPanelHeight, max(400, screen.visibleFrame.height - 28))
    }

    private func clampedFrame(_ rect: NSRect, on screen: NSScreen) -> NSRect {
        let safe = screen.visibleFrame.insetBy(dx: 8, dy: 8)
        let x = min(max(rect.minX, safe.minX), max(safe.minX, safe.maxX - rect.width))
        let y = min(max(rect.minY, safe.minY), max(safe.minY, safe.maxY - rect.height))
        return NSRect(x: x, y: y, width: rect.width, height: rect.height)
    }

    private func resolvedPanelFrame(restorePosition: Bool) -> NSRect {
        guard let target = preferredScreen() else {
            return NSRect(x: 160, y: 160, width: panelWidth, height: 600)
        }
        let size = NSSize(width: panelWidth, height: panelHeight(for: target))
        if restorePosition,
           let px = UserDefaults.standard.object(forKey: "windowX") as? Double,
           let py = UserDefaults.standard.object(forKey: "windowY") as? Double,
           px.isFinite, py.isFinite {
            for screen in NSScreen.screens {
                var candidate = NSRect(origin: NSPoint(x: CGFloat(px), y: CGFloat(py)), size: size)
                candidate.size.height = panelHeight(for: screen)
                let overlap = candidate.intersection(screen.visibleFrame)
                if !overlap.isNull && overlap.width >= panelWidth * 0.65 && overlap.height >= candidate.height * 0.65 {
                    return clampedFrame(candidate, on: screen)
                }
            }
        }
        let display = target.visibleFrame
        let fresh = NSRect(x: display.maxX - size.width - 18,
                           y: display.maxY - size.height - 18,
                           width: size.width, height: size.height)
        return clampedFrame(fresh, on: target)
    }

    private func presentPanel(resetPosition: Bool = false) {
        guard panel != nil else { return }
        let frame = resolvedPanelFrame(restorePosition: !resetPosition)
        model.panelHeight = frame.height
        panel.setFrame(frame, display: true, animate: false)
        panel.hidesOnDeactivate = false
        panel.level = model.pinned ? .floating : .normal
        panel.alphaValue = model.opacity
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
    }

    private func hidePanel() { panel.orderOut(nil) }

    @objc private func togglePanel() {
        guard panel != nil else { return }
        if panel.isVisible { hidePanel() } else { presentPanel() }
    }

    @objc private func resetPanelLocation() {
        UserDefaults.standard.removeObject(forKey: "windowX")
        UserDefaults.standard.removeObject(forKey: "windowY")
        presentPanel(resetPosition: true)
    }

    @objc private func copyBrowserPairingCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(BrowserBridge.pairingCode, forType: .string)
    }

    @objc private func openExtensionFolder() {
        let folder = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/TokenDesk/Chrome_Extension", isDirectory: true)
        if FileManager.default.fileExists(atPath: folder.path) {
            NSWorkspace.shared.open(folder)
        } else {
            model.browserBridgeState = "扩展文件夹不存在。请重新运行安装器。"
            model.showSettings = true
            presentPanel()
        }
    }

    func menuWillOpen(_ menu: NSMenu) { updateMenuBar() }

    @objc private func openBrowserUsage() {
        NSWorkspace.shared.open(URL(string: "https://chatgpt.com/settings/usage")!)
    }

    @objc private func showSettings() {
        model.showSettings = true
        presentPanel()
    }

    @objc private func quitApp() { NSApp.terminate(nil) }
}

@main
struct TokenDeskApp: App {
    @NSApplicationDelegateAdaptor(TokenDeskDelegate.self) private var delegate
    var body: some Scene {
        Settings { EmptyView() }
    }
}
