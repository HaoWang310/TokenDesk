using System.IO;
using System.Text.Json.Serialization;
using System.Security.Cryptography;
using System.Text.Json;

namespace TokenDesk.WindowsApp;

public sealed class AppStore
{
    private readonly object _gate = new();
    private readonly string _folder;
    private readonly string _path;
    private PersistedState _state;
    private List<RunningTaskState> _tasks = new();
    private List<DailyUsageState> _usageDays = new();

    public AppStore()
    {
        _folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TokenDesk");
        _path = Path.Combine(_folder, "state.json");
        Directory.CreateDirectory(_folder);
        _state = Load();
        if (_state.PairingCode.Length != 64)
        {
            _state.PairingCode = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            SaveLocked();
        }
        PruneHistoryLocked();
    }

    public string PairingCode
    {
        get { lock (_gate) return _state.PairingCode; }
    }

    public QuotaSnapshotState? LastQuota
    {
        get { lock (_gate) return _state.LastQuota; }
    }

    public IReadOnlyList<HistoryPoint> History
    {
        get { lock (_gate) return _state.History.ToList(); }
    }

    public IReadOnlyList<RunningTaskState> Tasks
    {
        get { lock (_gate) return _tasks.ToList(); }
    }

    public IReadOnlyList<DailyUsageState> UsageDays
    {
        get { lock (_gate) return _usageDays.ToList(); }
    }

    public IReadOnlyList<QuotaAlertEvent> SetQuota(QuotaSnapshotState quota)
    {
        lock (_gate)
        {
            var alerts = EvaluateAlertsLocked(_state.LastQuota, quota);
            _state.LastQuota = quota;
            var last = _state.History.LastOrDefault();
            var changed = last == null ||
                          last.FiveHourRemaining != quota.FiveHour?.RemainingPercent ||
                          last.WeeklyRemaining != quota.Weekly?.RemainingPercent;
            var oldEnough = last == null || quota.ObservedAt - last.Timestamp >= TimeSpan.FromMinutes(5);
            if (changed || oldEnough)
            {
                _state.History.Add(new HistoryPoint
                {
                    Timestamp = quota.ObservedAt,
                    FiveHourRemaining = quota.FiveHour?.RemainingPercent,
                    WeeklyRemaining = quota.Weekly?.RemainingPercent
                });
            }
            PruneHistoryLocked();
            SaveLocked();
            return alerts;
        }
    }

    private List<QuotaAlertEvent> EvaluateAlertsLocked(QuotaSnapshotState? previous, QuotaSnapshotState current)
    {
        var alerts = new List<QuotaAlertEvent>();

        (_state.FiveHourLowAlertCycle, _state.FiveHourResetAlertCycle) =
            EvaluateWindowLocked(
                "5小时",
                previous?.FiveHour,
                current.FiveHour,
                300,
                _state.FiveHourLowAlertCycle,
                _state.FiveHourResetAlertCycle,
                current.ObservedAt,
                alerts);

        (_state.WeeklyLowAlertCycle, _state.WeeklyResetAlertCycle) =
            EvaluateWindowLocked(
                "每周",
                previous?.Weekly,
                current.Weekly,
                10_080,
                _state.WeeklyLowAlertCycle,
                _state.WeeklyResetAlertCycle,
                current.ObservedAt,
                alerts);

        return alerts;
    }

    private static (string LowState, string ResetCycle) EvaluateWindowLocked(
        string label,
        QuotaWindowState? previous,
        QuotaWindowState? current,
        int durationMinutes,
        string lowState,
        string resetCycle,
        DateTimeOffset observedAt,
        List<QuotaAlertEvent> alerts)
    {
        if (current == null) return (lowState, resetCycle);

        var cycleChanged = false;

        // ChatGPT normally keeps one reset timestamp throughout a quota cycle.
        // A real reset moves that timestamp forward by roughly one full window.
        // Ignore small timestamp corrections so they cannot re-arm alerts.
        if (previous?.ResetsAt != null && current.ResetsAt != null)
        {
            var forwardShift = current.ResetsAt.Value - previous.ResetsAt.Value;
            var minimumShift = TimeSpan.FromMinutes(Math.Max(2.0, durationMinutes * 0.5));
            cycleChanged = forwardShift > minimumShift;
        }

        // Fallback when resetAt is missing or temporarily stale: a large refill
        // from depleted quota to a high remaining percentage is strong evidence
        // that a new cycle has actually started.
        if (!cycleChanged &&
            previous != null &&
            previous.RemainingPercent <= 30 &&
            current.RemainingPercent >= 70 &&
            current.RemainingPercent - previous.RemainingPercent >= 40)
        {
            cycleChanged = true;
        }

        if (cycleChanged)
        {
            // A confirmed new cycle re-arms the <=20% warning exactly once.
            lowState = "";

            var cycleToken = current.ResetsAt?.ToUnixTimeSeconds().ToString() ??
                             "refill-" + observedAt.ToUnixTimeSeconds();

            if (resetCycle != cycleToken)
            {
                alerts.Add(new QuotaAlertEvent
                {
                    Title = $"TokenDesk · {label}额度已刷新",
                    Message = $"新的{label}额度周期已经开始，当前剩余 {current.RemainingPercent}%。"
                });
                resetCycle = cycleToken;
            }
        }

        // Persistent latch: once the <=20% warning has been shown, closing it
        // does not cause another warning in the same cycle. It is cleared only
        // by the confirmed cycle-change branch above.
        if (current.RemainingPercent <= 20 && string.IsNullOrEmpty(lowState))
        {
            var resetText = current.ResetsAt == null
                ? ""
                : $"，预计 {current.ResetsAt.Value.ToLocalTime():M/d HH:mm} 刷新";

            alerts.Add(new QuotaAlertEvent
            {
                Title = $"TokenDesk · {label}额度剩余20%或以下",
                Message = $"当前剩余 {current.RemainingPercent}%{resetText}。"
            });

            lowState = current.ResetsAt?.ToUnixTimeSeconds().ToString() ?? "shown";
        }

        return (lowState, resetCycle);
    }

    public void SetTaskSnapshot(TaskSnapshotState snapshot)
    {
        lock (_gate)
        {
            _tasks = snapshot.Tasks
                .Where(t => DateTimeOffset.UtcNow - t.LastSeenAt < (t.Phase == TaskPhase.Unverified
                    ? TimeSpan.FromHours(2) : TimeSpan.FromSeconds(90)))
                .OrderBy(t => t.StartedAt)
                .Take(32)
                .ToList();
            _usageDays = snapshot.UsageDays
                .OrderBy(d => d.Day, StringComparer.Ordinal)
                .TakeLast(7)
                .ToList();
        }
    }

    private PersistedState Load()
    {
        try
        {
            if (!File.Exists(_path)) return NewState();
            return JsonSerializer.Deserialize<PersistedState>(File.ReadAllText(_path), JsonOptions()) ?? NewState();
        }
        catch
        {
            return NewState();
        }
    }

    private static PersistedState NewState() => new()
    {
        PairingCode = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant()
    };

    private void PruneHistoryLocked()
    {
        var cutoff = DateTimeOffset.UtcNow.AddDays(-7);
        _state.History = _state.History
            .Where(p => p.Timestamp >= cutoff)
            .OrderBy(p => p.Timestamp)
            .TakeLast(4000)
            .ToList();
    }

    private void SaveLocked()
    {
        try
        {
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_state, JsonOptions()));
            File.Move(temp, _path, true);
        }
        catch
        {
            // Monitoring should continue even if local history cannot be persisted.
        }
    }

    private static JsonSerializerOptions JsonOptions() => new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };
}
