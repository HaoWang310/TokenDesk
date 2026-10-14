using Microsoft.Win32;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using WpfBrush = System.Windows.Media.Brush;
using WpfBrushes = System.Windows.Media.Brushes;
using WpfColor = System.Windows.Media.Color;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace TokenDesk.WindowsApp;

public partial class MainWindow : Window
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "TokenDesk";
    private readonly AppStore _store;
    private readonly DispatcherTimer _timer;
    private string _bridgeState = "等待 Chrome…";

    public ObservableCollection<TaskRowVm> Tasks { get; } = new();

    public MainWindow(AppStore store)
    {
        InitializeComponent();
        _store = store;
        DataContext = this;
        PairingCodeText.Text = _store.PairingCode;
        AutoStartCheck.IsChecked = IsAutoStartEnabled();

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _timer.Tick += (_, _) => RefreshFromStore();
        _timer.Start();

        Loaded += (_, _) => RefreshFromStore();
    }

    public void SetBridgeState(string state)
    {
        _bridgeState = state;
        RefreshFromStore();
    }

    public void RefreshFromStore()
    {
        var quota = _store.LastQuota;
        if (quota == null)
        {
            FiveHourText.Text = "—";
            WeeklyText.Text = "—";
            FiveHourResetText.Text = "重置：—";
            WeeklyResetText.Text = "重置：—";
            ResetCountText.Text = "可用重置：—";
            ConnectionText.Text = _bridgeState;
        }
        else
        {
            FiveHourText.Text = quota.FiveHour == null ? "—" : $"{quota.FiveHour.RemainingPercent}%";
            WeeklyText.Text = quota.Weekly == null ? "—" : $"{quota.Weekly.RemainingPercent}%";
            FiveHourResetText.Text = ResetText(quota.FiveHour?.ResetsAt);
            WeeklyResetText.Text = ResetText(quota.Weekly?.ResetsAt);
            ResetCountText.Text = quota.AvailableResets == null ? "可用重置：—" : $"可用重置：{quota.AvailableResets} 次";
            var age = DateTimeOffset.UtcNow - quota.ObservedAt;
            ConnectionText.Text = age <= TimeSpan.FromSeconds(90)
                ? $"已连接 · {quota.SourceLabel}"
                : $"额度已过期 · {Math.Max(0, (int)age.TotalMinutes)} 分钟前";
        }

        RefreshTasks();
        DrawWeeklyUsage();
        DrawHistory();
    }

    private void RefreshTasks()
    {
        var source = _store.Tasks
            .Where(t => DateTimeOffset.UtcNow - t.LastSeenAt < TimeSpan.FromSeconds(90))
            .Take(20)
            .ToList();

        Tasks.Clear();
        foreach (var task in source.Take(8))
        {
            Tasks.Add(new TaskRowVm
            {
                Title = task.Title,
                PageUrl = task.PageUrl,
                ModelLabel = string.IsNullOrWhiteSpace(task.ModelName) ? "模型：未识别" : "模型：" + task.ModelName,
                PhaseLabel = task.Phase == TaskPhase.Thinking ? "思考" : "工作",
                PhaseBrush = task.Phase == TaskPhase.Thinking
                    ? new SolidColorBrush(WpfColor.FromRgb(154, 181, 255))
                    : new SolidColorBrush(WpfColor.FromRgb(126, 207, 176)),
                Elapsed = "已运行 " + Elapsed(task.StartedAt)
            });
        }

        var thinking = source.Count(t => t.Phase == TaskPhase.Thinking);
        var working = source.Count(t => t.Phase == TaskPhase.Working);
        TaskSummaryText.Text = thinking + working == 0
            ? "任务 0"
            : string.Join(" · ", new[]
            {
                thinking > 0 ? $"思考 {thinking}" : "",
                working > 0 ? $"工作 {working}" : ""
            }.Where(x => x.Length > 0));
        NoTasksText.Visibility = source.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void DrawWeeklyUsage()
    {
        if (ActiveUsageCanvas.ActualWidth < 20 || QuotaUsageCanvas.ActualWidth < 20) return;

        var days = _store.UsageDays
            .OrderBy(d => d.Day, StringComparer.Ordinal)
            .TakeLast(7)
            .ToList();

        var todayKey = DateTime.Now.ToString("yyyy-MM-dd");
        var today = days.LastOrDefault(d => d.Day == todayKey);
        var totalSeconds = days.Sum(d => d.ActiveSeconds);
        var totalQuota = days.Sum(d => d.WeeklyQuotaUsed);

        TodayActiveText.Text = DurationText(today?.ActiveSeconds ?? 0);
        WeekActiveText.Text = DurationText(totalSeconds);
        WeekQuotaTotalText.Text =
            $"7 天用量累计：{totalQuota}%。使用时间仅统计 ChatGPT 标签页前台且最近 5 分钟有交互的时间；用量不是 Token 数。";

        DrawBarChart(ActiveUsageCanvas, days,
            d => d.ActiveSeconds,
            value => DurationText((int)value));
        DrawBarChart(QuotaUsageCanvas, days,
            d => d.WeeklyQuotaUsed,
            value => $"{(int)value}%");
    }

    private static void DrawBarChart(Canvas canvas,
        IReadOnlyList<DailyUsageState> days,
        Func<DailyUsageState, double> selector,
        Func<double, string> valueText)
    {
        canvas.Children.Clear();
        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;
        if (width < 20 || height < 40) return;

        if (days.Count == 0)
        {
            canvas.Children.Add(new TextBlock
            {
                Text = "更新 Chrome 扩展后开始记录",
                Foreground = new SolidColorBrush(WpfColor.FromRgb(116, 125, 141)),
                FontSize = 10
            });
            return;
        }

        var chartTop = 18.0;
        var chartBottom = height - 22.0;
        var chartHeight = Math.Max(10, chartBottom - chartTop);
        var maxValue = Math.Max(1.0, days.Max(selector));

        canvas.Children.Add(new Line
        {
            X1 = 0,
            X2 = width,
            Y1 = chartBottom,
            Y2 = chartBottom,
            Stroke = new SolidColorBrush(WpfColor.FromArgb(45, 255, 255, 255)),
            StrokeThickness = 1
        });

        var slot = width / days.Count;
        var barWidth = Math.Max(8, Math.Min(30, slot * 0.52));

        for (var i = 0; i < days.Count; i++)
        {
            var value = Math.Max(0, selector(days[i]));
            var barHeight = value <= 0 ? 2 : Math.Max(3, chartHeight * value / maxValue);
            var left = i * slot + (slot - barWidth) / 2.0;
            var top = chartBottom - barHeight;

            var bar = new Rectangle
            {
                Width = barWidth,
                Height = barHeight,
                RadiusX = 3,
                RadiusY = 3,
                Fill = new SolidColorBrush(WpfColor.FromRgb(126, 207, 176)),
                Opacity = value > 0 ? 0.9 : 0.22
            };
            Canvas.SetLeft(bar, left);
            Canvas.SetTop(bar, top);
            canvas.Children.Add(bar);

            var valueLabel = new TextBlock
            {
                Text = valueText(value),
                Foreground = new SolidColorBrush(WpfColor.FromRgb(126, 135, 152)),
                FontSize = 7.5,
                Width = slot,
                TextAlignment = TextAlignment.Center
            };
            Canvas.SetLeft(valueLabel, i * slot);
            Canvas.SetTop(valueLabel, Math.Max(0, top - 15));
            canvas.Children.Add(valueLabel);

            var dateParts = days[i].Day.Split('-');
            var dateLabel = dateParts.Length == 3
                ? $"{int.TryParse(dateParts[1], out var month) switch { true => month, false => 0 }}/{int.TryParse(dateParts[2], out var day) switch { true => day, false => 0 }}"
                : days[i].Day;
            var label = new TextBlock
            {
                Text = dateLabel,
                Foreground = new SolidColorBrush(WpfColor.FromRgb(100, 109, 125)),
                FontSize = 7.5,
                Width = slot,
                TextAlignment = TextAlignment.Center
            };
            Canvas.SetLeft(label, i * slot);
            Canvas.SetTop(label, height - 18);
            canvas.Children.Add(label);
        }
    }

    private static string DurationText(int seconds)
    {
        var minutes = Math.Max(0, seconds) / 60;
        if (minutes < 60) return $"{minutes}分";
        return $"{minutes / 60}时{minutes % 60}分";
    }

    private void DrawHistory()
    {
        if (HistoryCanvas.ActualWidth < 20 || HistoryCanvas.ActualHeight < 20) return;
        HistoryCanvas.Children.Clear();

        var history = _store.History.OrderBy(p => p.Timestamp).ToList();
        if (history.Count == 0)
        {
            HistoryRangeText.Text = "暂无历史";
            return;
        }

        var end = DateTimeOffset.UtcNow;
        var first = history[0].Timestamp;
        var observed = end - first;
        TimeSpan span;
        if (observed >= TimeSpan.FromHours(23.5)) span = TimeSpan.FromHours(24);
        else if (observed < TimeSpan.FromHours(1))
            span = TimeSpan.FromMinutes(Math.Max(30, observed.TotalMinutes * 1.12));
        else
            span = TimeSpan.FromHours(Math.Min(24, Math.Max(1, observed.TotalHours * 1.05)));

        var start = end - span;
        var points = history.Where(p => p.Timestamp >= start && p.Timestamp <= end).ToList();
        HistoryRangeText.Text = span.TotalHours >= 23.5 ? "最近 24 小时" : $"{Math.Max(1, (int)Math.Ceiling(span.TotalMinutes))} 分钟";

        var width = HistoryCanvas.ActualWidth;
        var height = HistoryCanvas.ActualHeight;
        for (var i = 0; i <= 2; i++)
        {
            var y = height * i / 2.0;
            HistoryCanvas.Children.Add(new Line
            {
                X1 = 0, X2 = width, Y1 = y, Y2 = y,
                Stroke = new SolidColorBrush(WpfColor.FromArgb(36, 255, 255, 255)),
                StrokeThickness = 1
            });
        }

        AddSeries(points, start, end, width, height, p => p.FiveHourRemaining,
            WpfColor.FromRgb(126, 207, 176));
        AddSeries(points, start, end, width, height, p => p.WeeklyRemaining,
            WpfColor.FromRgb(145, 168, 255));
    }

    private void AddSeries(List<HistoryPoint> points, DateTimeOffset start, DateTimeOffset end,
        double width, double height, Func<HistoryPoint, int?> selector, WpfColor color)
    {
        var series = new Polyline
        {
            Stroke = new SolidColorBrush(color),
            StrokeThickness = 2,
            StrokeLineJoin = PenLineJoin.Round
        };
        var duration = Math.Max(1, (end - start).TotalSeconds);
        foreach (var point in points)
        {
            var value = selector(point);
            if (value == null) continue;
            var x = Math.Clamp((point.Timestamp - start).TotalSeconds / duration, 0, 1) * width;
            var y = (1 - Math.Clamp(value.Value / 100.0, 0, 1)) * height;
            series.Points.Add(new System.Windows.Point(x, y));
        }
        if (series.Points.Count > 0) HistoryCanvas.Children.Add(series);
    }

    private static string ResetText(DateTimeOffset? reset)
    {
        if (reset == null) return "重置：—";
        return "重置：" + reset.Value.ToLocalTime().ToString("M/d HH:mm");
    }

    private static string Elapsed(DateTimeOffset start)
    {
        var seconds = Math.Max(0, (int)(DateTimeOffset.UtcNow - start).TotalSeconds);
        if (seconds < 60) return $"{seconds}秒";
        if (seconds < 3600) return $"{seconds / 60}分{seconds % 60}秒";
        return $"{seconds / 3600}时{(seconds % 3600) / 60}分";
    }

    private void HistoryCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => DrawHistory();
    private void WeeklyCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => DrawWeeklyUsage();

    private void CopyPairing_Click(object sender, RoutedEventArgs e)
    {
        System.Windows.Clipboard.SetText(_store.PairingCode);
    }

    private void TaskOpen_Click(object sender, RoutedEventArgs e)
    {
        if (sender is System.Windows.Controls.Button button && button.Tag is string url && Uri.TryCreate(url, UriKind.Absolute, out _))
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }
    }

    private void OpenExtensionFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = System.IO.Path.Combine(AppContext.BaseDirectory, "Chrome_Extension");
        if (!System.IO.Directory.Exists(folder))
        {
            System.Windows.MessageBox.Show("当前程序目录中没有 Chrome_Extension 文件夹。请使用 GitHub Actions 发布包。", "TokenDesk");
            return;
        }
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true });
    }

    private void OpenChromeExtensions_Click(object sender, RoutedEventArgs e) => OpenBrowserExtensions("chrome.exe", "chrome://extensions");
    private void OpenEdgeExtensions_Click(object sender, RoutedEventArgs e) => OpenBrowserExtensions("msedge.exe", "edge://extensions");

    private static void OpenBrowserExtensions(string exe, string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(exe, uri) { UseShellExecute = true });
        }
        catch
        {
            System.Windows.MessageBox.Show($"无法自动打开 {exe}。请手动进入 {uri}", "TokenDesk");
        }
    }

    private void AutoStart_Changed(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded) return;
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (AutoStartCheck.IsChecked == true)
            {
                var exe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
                if (!string.IsNullOrWhiteSpace(exe))
                    key.SetValue(RunValueName, $"\"{exe}\" --tray");
            }
            else
            {
                key.DeleteValue(RunValueName, false);
            }
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show("无法修改开机启动设置：" + ex.Message, "TokenDesk");
        }
    }

    private static bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunValueName) != null;
        }
        catch
        {
            return false;
        }
    }

    private void Window_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (System.Windows.Application.Current is App app && !app.IsExiting)
        {
            e.Cancel = true;
            Hide();
        }
    }
}

public sealed class TaskRowVm
{
    public string Title { get; set; } = "";
    public string PageUrl { get; set; } = "";
    public string ModelLabel { get; set; } = "";
    public string PhaseLabel { get; set; } = "";
    public WpfBrush PhaseBrush { get; set; } = WpfBrushes.White;
    public string Elapsed { get; set; } = "";
}
