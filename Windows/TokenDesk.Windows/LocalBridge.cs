using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace TokenDesk.WindowsApp;

public sealed class LocalBridge : IDisposable
{
    public const int Port = 18743;
    private readonly string _pairingCode;
    private readonly CancellationTokenSource _cts = new();
    private TcpListener? _listener;

    public event Action<QuotaSnapshotState>? QuotaReceived;
    public event Action<TaskSnapshotState>? TasksReceived;
    public event Action<string>? StateChanged;

    public LocalBridge(string pairingCode)
    {
        _pairingCode = pairingCode;
    }

    public void Start()
    {
        try
        {
            _listener = new TcpListener(IPAddress.Loopback, Port);
            _listener.Start();
            StateChanged?.Invoke("本地桥接已启动 · 127.0.0.1:18743");
            _ = AcceptLoopAsync(_cts.Token);
        }
        catch (Exception ex)
        {
            StateChanged?.Invoke("本地桥接启动失败：" + ex.Message);
        }
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        if (_listener == null) return;
        while (!token.IsCancellationRequested)
        {
            try
            {
                var client = await _listener.AcceptTcpClientAsync(token);
                _ = HandleClientAsync(client, token);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                StateChanged?.Invoke("桥接监听异常：" + ex.Message);
                await Task.Delay(500, token);
            }
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken token)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                using var stream = client.GetStream();
                var request = await ReadRequestAsync(stream, token);
                if (request == null)
                {
                    await WriteResponseAsync(stream, 400, "Bad Request", "{\"ok\":false}", token);
                    return;
                }

                if (request.Method == "OPTIONS" &&
                    (request.Path == "/ingest" || request.Path == "/tasks" || request.Path == "/health"))
                {
                    await WriteResponseAsync(stream, 204, "No Content", "", token);
                    return;
                }

                if (request.Method == "GET" && request.Path == "/health")
                {
                    await WriteResponseAsync(stream, 200, "OK", "{\"ok\":true,\"app\":\"TokenDesk Windows\"}", token);
                    return;
                }

                if (request.Method != "POST" || (request.Path != "/ingest" && request.Path != "/tasks"))
                {
                    await WriteResponseAsync(stream, 404, "Not Found", "{\"ok\":false}", token);
                    return;
                }

                if (!request.Headers.TryGetValue("x-tokendesk-key", out var key) ||
                    !CryptographicEquals(key.Trim(), _pairingCode))
                {
                    await WriteResponseAsync(stream, 401, "Unauthorized", "{\"ok\":false}", token);
                    return;
                }

                if (request.Path == "/ingest")
                {
                    var quota = ParseQuota(request.Body);
                    if (quota == null)
                    {
                        await WriteResponseAsync(stream, 422, "Unprocessable Entity", "{\"ok\":false}", token);
                        return;
                    }
                    QuotaReceived?.Invoke(quota);
                }
                else
                {
                    var tasks = ParseTasks(request.Body);
                    if (tasks == null)
                    {
                        await WriteResponseAsync(stream, 422, "Unprocessable Entity", "{\"ok\":false}", token);
                        return;
                    }
                    TasksReceived?.Invoke(tasks);
                }

                await WriteResponseAsync(stream, 200, "OK", "{\"ok\":true}", token);
            }
            catch
            {
                // Individual malformed browser requests must not terminate the listener.
            }
        }
    }

    private static bool CryptographicEquals(string a, string b)
    {
        if (a.Length != b.Length) return false;
        var aa = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(aa, bb);
    }

    private static QuotaSnapshotState? ParseQuota(byte[] body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var pageUrl = GetString(root, "pageURL");
            if (!IsAllowedChatGptUrl(pageUrl)) return null;

            var five = GetPercent(root, "fiveHourRemaining");
            var week = GetPercent(root, "weeklyRemaining");
            if (five == null && week == null) return null;

            var direct = GetBool(root, "backgroundDirect");
            var source = GetString(root, "source");
            var label = direct ? "Chrome 后台主动查询" :
                        string.Equals(source, "network", StringComparison.OrdinalIgnoreCase) ? "页面网络备用读取" :
                        "页面 DOM 备用读取";

            return new QuotaSnapshotState
            {
                FiveHour = five == null ? null : new QuotaWindowState
                {
                    RemainingPercent = five.Value,
                    ResetsAt = GetUnixSeconds(root, "fiveHourResetsAt")
                },
                Weekly = week == null ? null : new QuotaWindowState
                {
                    RemainingPercent = week.Value,
                    ResetsAt = GetUnixSeconds(root, "weeklyResetsAt")
                },
                AvailableResets = GetInt(root, "availableResets", 0, 20),
                ObservedAt = DateTimeOffset.UtcNow,
                SourceLabel = label
            };
        }
        catch
        {
            return null;
        }
    }

    private static TaskSnapshotState? ParseTasks(byte[] body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (!root.TryGetProperty("tasks", out var tasksEl) || tasksEl.ValueKind != JsonValueKind.Array) return null;
            if (tasksEl.GetArrayLength() > 32) return null;

            var result = new List<RunningTaskState>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in tasksEl.EnumerateArray())
            {
                var id = GetString(item, "id");
                var title = GetString(item, "title");
                var url = GetString(item, "pageURL");
                if (string.IsNullOrWhiteSpace(id) || id.Length > 180 || !seen.Add(id) || !IsAllowedChatGptUrl(url)) continue;
                var phase = string.Equals(GetString(item, "phase"), "thinking", StringComparison.OrdinalIgnoreCase)
                    ? TaskPhase.Thinking : TaskPhase.Working;
                var now = DateTimeOffset.UtcNow;
                result.Add(new RunningTaskState
                {
                    Id = id,
                    Phase = phase,
                    Title = string.IsNullOrWhiteSpace(title) ? "ChatGPT 任务" : title.Trim()[..Math.Min(title.Trim().Length, 100)],
                    PageUrl = url,
                    ModelName = GetString(item, "model").Trim()[..Math.Min(GetString(item, "model").Trim().Length, 64)],
                    StartedAt = GetUnixSeconds(item, "startedAt") ?? now,
                    LastSeenAt = GetUnixSeconds(item, "lastSeenAt") ?? now
                });
            }
            var usageDays = new List<DailyUsageState>();
            if (root.TryGetProperty("usageDays", out var usageEl) && usageEl.ValueKind == JsonValueKind.Array &&
                usageEl.GetArrayLength() <= 8)
            {
                foreach (var dayEl in usageEl.EnumerateArray())
                {
                    var day = GetString(dayEl, "day");
                    if (day.Length != 10 || day[4] != '-' || day[7] != '-') continue;
                    var active = GetInt(dayEl, "activeSeconds", 0, 86_400);
                    var quota = GetInt(dayEl, "weeklyQuotaUsed", 0, 500);
                    if (active == null || quota == null) continue;
                    usageDays.Add(new DailyUsageState
                    {
                        Day = day,
                        ActiveSeconds = active.Value,
                        WeeklyQuotaUsed = quota.Value
                    });
                }
            }

            return new TaskSnapshotState
            {
                Tasks = result.OrderBy(t => t.StartedAt).ToList(),
                UsageDays = usageDays.OrderBy(d => d.Day, StringComparer.Ordinal).ToList()
            };
        }
        catch
        {
            return null;
        }
    }

    private static bool IsAllowedChatGptUrl(string value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
               uri.Scheme == Uri.UriSchemeHttps &&
               (string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(uri.Host, "chat.openai.com", StringComparison.OrdinalIgnoreCase));
    }

    private static int? GetPercent(JsonElement root, string name) => GetInt(root, name, 0, 100);

    private static int? GetInt(JsonElement root, string name, int min, int max)
    {
        if (!root.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Number || !el.TryGetInt32(out var value)) return null;
        return value >= min && value <= max ? value : null;
    }

    private static bool GetBool(JsonElement root, string name) =>
        root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.True;

    private static string GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? (el.GetString() ?? "") : "";

    private static DateTimeOffset? GetUnixSeconds(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Number) return null;
        if (!el.TryGetInt64(out var raw) || raw <= 0) return null;
        try
        {
            if (raw > 10_000_000_000) raw /= 1000;
            return DateTimeOffset.FromUnixTimeSeconds(raw);
        }
        catch
        {
            return null;
        }
    }

    private sealed class HttpRequestData
    {
        public string Method { get; init; } = "";
        public string Path { get; init; } = "";
        public Dictionary<string, string> Headers { get; init; } = new(StringComparer.OrdinalIgnoreCase);
        public byte[] Body { get; init; } = Array.Empty<byte>();
    }

    private static async Task<HttpRequestData?> ReadRequestAsync(NetworkStream stream, CancellationToken token)
    {
        var headerBytes = new List<byte>(2048);
        var tail = new Queue<byte>(4);
        while (headerBytes.Count < 16_384)
        {
            var one = new byte[1];
            var read = await stream.ReadAsync(one.AsMemory(0, 1), token);
            if (read == 0) return null;
            headerBytes.Add(one[0]);
            tail.Enqueue(one[0]);
            if (tail.Count > 4) tail.Dequeue();
            if (tail.Count == 4 && tail.SequenceEqual(new byte[] { 13, 10, 13, 10 })) break;
        }
        if (headerBytes.Count >= 16_384) return null;

        var headerText = Encoding.UTF8.GetString(headerBytes.ToArray());
        var lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
        var first = lines.FirstOrDefault()?.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (first == null || first.Length < 2) return null;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            if (string.IsNullOrEmpty(line)) break;
            var index = line.IndexOf(':');
            if (index <= 0) continue;
            headers[line[..index].Trim()] = line[(index + 1)..].Trim();
        }

        var length = 0;
        if (headers.TryGetValue("content-length", out var rawLength) &&
            (!int.TryParse(rawLength, out length) || length < 0 || length > 65_536))
            return null;

        var body = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(body.AsMemory(offset, length - offset), token);
            if (read == 0) return null;
            offset += read;
        }

        return new HttpRequestData
        {
            Method = first[0].ToUpperInvariant(),
            Path = first[1].Split('?')[0],
            Headers = headers,
            Body = body
        };
    }

    private static async Task WriteResponseAsync(NetworkStream stream, int code, string reason, string body, CancellationToken token)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var header = $"HTTP/1.1 {code} {reason}\r\n" +
                     "Content-Type: application/json; charset=utf-8\r\n" +
                     $"Content-Length: {bytes.Length}\r\n" +
                     "Access-Control-Allow-Origin: *\r\n" +
                     "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                     "Access-Control-Allow-Headers: Content-Type, X-TokenDesk-Key\r\n" +
                     "Connection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(header), token);
        if (bytes.Length > 0) await stream.WriteAsync(bytes, token);
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener?.Stop(); } catch { }
        _cts.Dispose();
    }
}
