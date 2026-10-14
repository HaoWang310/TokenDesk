using System.Text.Json.Serialization;

namespace TokenDesk.WindowsApp;

public enum TaskPhase
{
    Thinking,
    Working
}

public sealed class QuotaWindowState
{
    public int RemainingPercent { get; set; }
    public DateTimeOffset? ResetsAt { get; set; }
}

public sealed class QuotaSnapshotState
{
    public QuotaWindowState? FiveHour { get; set; }
    public QuotaWindowState? Weekly { get; set; }
    public int? AvailableResets { get; set; }
    public DateTimeOffset ObservedAt { get; set; } = DateTimeOffset.UtcNow;
    public string SourceLabel { get; set; } = "Chrome";
}

public sealed class RunningTaskState
{
    public string Id { get; set; } = "";
    public TaskPhase Phase { get; set; }
    public string Title { get; set; } = "ChatGPT 任务";
    public string PageUrl { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
}

public sealed class HistoryPoint
{
    public DateTimeOffset Timestamp { get; set; }
    public int? FiveHourRemaining { get; set; }
    public int? WeeklyRemaining { get; set; }
}

public sealed class QuotaAlertEvent
{
    public string Title { get; set; } = "";
    public string Message { get; set; } = "";
}

public sealed class PersistedState
{
    public string PairingCode { get; set; } = "";
    public QuotaSnapshotState? LastQuota { get; set; }
    public List<HistoryPoint> History { get; set; } = new();
    public string FiveHourLowAlertCycle { get; set; } = "";
    public string WeeklyLowAlertCycle { get; set; } = "";
}
