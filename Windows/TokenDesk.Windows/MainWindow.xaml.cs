using Microsoft.Win32;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
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
                PhaseLabel = task.Phase == TaskPhase.Thinking ? "思考" : "工作",
                PhaseBrush = task.Phase == TaskPhase.Thinking
                    ? new SolidColorBrush(Color.FromRgb(154, 181, 255))
                    : new SolidColorBrush(Color.FromRgb(126, 207, 176)),
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
                Stroke = new SolidColorBrush(Color.FromArgb(36, 255, 255, 255)),
                StrokeThickness = 1
            });
        }

        AddSeries(points, start, end, width, height, p => p.FiveHourRemaining,
            Color.FromRgb(126, 207, 176));
        AddSeries(points, start, end, width, height, p => p.WeeklyRemaining,
            Color.FromRgb(145, 168, 255));
    }

    private void AddSeries(List<HistoryPoint> points, DateTimeOffset start, DateTimeOffset end,
        double width, double height, Func<HistoryPoint, int?> selector, Color color)
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
            series.Points.Add(new Point(x, y));
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

    private void CopyPairing_Click(object sender, RoutedEventArgs e)
    {
        Clipboard.SetText(_store.PairingCode);
    }

    private void TaskOpen_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is string url && Uri.TryCreate(url, UriKind.Absolute, out _))
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }
    }

    private void OpenExtensionFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = Path.Combine(AppContext.BaseDirectory, "Chrome_Extension");
        if (!Directory.Exists(folder))
        {
            MessageBox.Show("当前程序目录中没有 Chrome_Extension 文件夹。请使用 GitHub Actions 发布包。", "TokenDesk");
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
            MessageBox.Show($"无法自动打开 {exe}。请手动进入 {uri}", "TokenDesk");
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
            MessageBox.Show("无法修改开机启动设置：" + ex.Message, "TokenDesk");
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
    public string PhaseLabel { get; set; } = "";
    public Brush PhaseBrush { get; set; } = Brushes.White;
    public string Elapsed { get; set; } = "";
}
