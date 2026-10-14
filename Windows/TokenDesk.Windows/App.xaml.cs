using System.Drawing;
using System.Windows;
using Forms = System.Windows.Forms;

namespace TokenDesk.WindowsApp;

public partial class App : System.Windows.Application
{
    private AppStore? _store;
    private LocalBridge? _bridge;
    private MainWindow? _window;
    private Forms.NotifyIcon? _trayIcon;

    public bool IsExiting { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _store = new AppStore();
        _window = new MainWindow(_store);
        MainWindow = _window;

        _bridge = new LocalBridge(_store.PairingCode);
        _bridge.StateChanged += state => Dispatcher.Invoke(() =>
        {
            _window?.SetBridgeState(state);
            UpdateTray();
        });
        _bridge.QuotaReceived += quota => Dispatcher.Invoke(() =>
        {
            _store.SetQuota(quota);
            _window?.RefreshFromStore();
            UpdateTray();
        });
        _bridge.TasksReceived += tasks => Dispatcher.Invoke(() =>
        {
            _store.SetTasks(tasks);
            _window?.RefreshFromStore();
            UpdateTray();
        });
        _bridge.Start();

        CreateTray();

        var startHidden = e.Args.Any(a => string.Equals(a, "--tray", StringComparison.OrdinalIgnoreCase));
        if (!startHidden)
        {
            _window.Show();
            _window.Activate();
        }

        UpdateTray();
    }

    private void CreateTray()
    {
        _trayIcon = new Forms.NotifyIcon
        {
            Icon = SystemIcons.Application,
            Visible = true,
            Text = "TokenDesk"
        };

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("打开 TokenDesk", null, (_, _) => ShowWindow());
        menu.Items.Add("复制配对码", null, (_, _) =>
        {
            if (_store != null) Clipboard.SetText(_store.PairingCode);
        });
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitApplication());
        _trayIcon.ContextMenuStrip = menu;
        _trayIcon.MouseClick += (_, args) =>
        {
            if (args.Button == Forms.MouseButtons.Left) ShowWindow();
        };
    }

    private void ShowWindow()
    {
        if (_window == null) return;
        if (!_window.IsVisible) _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Activate();
        _window.Topmost = true;
        _window.Topmost = false;
    }

    public void ExitApplication()
    {
        IsExiting = true;
        _bridge?.Dispose();
        if (_trayIcon != null)
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
        }
        _window?.Close();
        Shutdown();
    }

    public void UpdateTray()
    {
        if (_trayIcon == null || _store == null) return;
        var quota = _store.LastQuota;
        var tasks = _store.Tasks;
        var five = quota?.FiveHour?.RemainingPercent.ToString() ?? "—";
        var week = quota?.Weekly?.RemainingPercent.ToString() ?? "—";
        var thinking = tasks.Count(t => t.Phase == TaskPhase.Thinking);
        var working = tasks.Count(t => t.Phase == TaskPhase.Working);
        var taskText = thinking + working == 0 ? "任务 0" : string.Join(" · ",
            new[]
            {
                thinking > 0 ? $"思考 {thinking}" : "",
                working > 0 ? $"工作 {working}" : ""
            }.Where(x => x.Length > 0));
        var text = $"TokenDesk · 5h {five}% · 周 {week}% · {taskText}";
        _trayIcon.Text = text.Length <= 63 ? text : text[..63];
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _bridge?.Dispose();
        if (_trayIcon != null)
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
        }
        base.OnExit(e);
    }
}
