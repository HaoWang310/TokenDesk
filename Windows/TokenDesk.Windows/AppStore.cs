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
        _state.FiveHourLowAlertCycle = EvaluateWindowLocked("5小时", current.FiveHour, 300, _state.FiveHourLowAlertCycle, alerts);
        _state.WeeklyLowAlertCycle = EvaluateWindowLocked("每周", current.Weekly, 10_080, _state.WeeklyLowAlertCycle, alerts);

        AddResetAlertIfAdvanced("5小时", previous?.FiveHour, current.FiveHour, alerts);
        AddResetAlertIfAdvanced("每周", previous?.Weekly, current.Weekly, alerts);
        return alerts;
    }

    private static string EvaluateWindowLocked(string label,
        QuotaWindowState? window,
        int fallbackMinutes,
        string storedCycle,
        List<QuotaAlertEvent> alerts)
    {
        if (window == null) return storedCycle;
        var cycle = window.ResetsAt?.ToUnixTimeSeconds().ToString() ??
                    "fallback-" + (DateTimeOffset.UtcNow.ToUnixTimeSeconds() / Math.Max(60, fallbackMinutes * 60));

        if (window.RemainingPercent <= 20 && storedCycle != cycle)
        {
            var reset = window.ResetsAt == null
                ? ""
                : $"，预计 {window.ResetsAt.Value.ToLocalTime():M/d HH:mm} 刷新";
            alerts.Add(new QuotaAlertEvent
            {
                Title = $"TokenDesk · {label}额度剩余20%或以下",
                Message = $"当前剩余 {window.RemainingPercent}%{reset}。"
            });
            return cycle;
        }
        return storedCycle;
    }

    private static void AddResetAlertIfAdvanced(string label,
        QuotaWindowState? previous,
        QuotaWindowState? current,
        List<QuotaAlertEvent> alerts)
    {
        if (previous?.ResetsAt == null || current?.ResetsAt == null) return;
        if (current.ResetsAt <= previous.ResetsAt) return;

        // A later reset timestamp means ChatGPT has moved into a new quota cycle.
        alerts.Add(new QuotaAlertEvent
        {
            Title = $"TokenDesk · {label}额度已刷新",
            Message = $"新的{label}额度周期已经开始，当前剩余 {current.RemainingPercent}%。"
        });
    }

    public void SetTasks(IEnumerable<RunningTaskState> tasks)
    {
        lock (_gate)
        {
            _tasks = tasks
                .Where(t => DateTimeOffset.UtcNow - t.LastSeenAt < TimeSpan.FromSeconds(90))
                .OrderBy(t => t.StartedAt)
                .Take(32)
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
