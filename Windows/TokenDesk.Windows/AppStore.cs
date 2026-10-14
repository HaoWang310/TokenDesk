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

    public void SetQuota(QuotaSnapshotState quota)
    {
        lock (_gate)
        {
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
        }
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
