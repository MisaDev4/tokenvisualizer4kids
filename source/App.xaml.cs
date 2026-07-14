using System.Drawing;
using System.Windows;
using Forms = System.Windows.Forms;

namespace TokenTracker;

public partial class App : System.Windows.Application
{
    private const string InstanceMutexName = "TokenTracker.SingleInstance";

    /// <summary>Broadcast by a second launch so the running instance shows its window.</summary>
    public static readonly int ShowWindowMessage = RegisterWindowMessage("TokenTracker.ShowWindow");

    private Forms.NotifyIcon? _trayIcon;
    private MainWindow? _window;
    private Mutex? _instanceMutex;

    public bool IsExiting { get; private set; }

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int RegisterWindowMessage(string message);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _instanceMutex = new Mutex(initiallyOwned: true, InstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            var broadcast = new IntPtr(0xFFFF);
            PostMessage(broadcast, ShowWindowMessage, IntPtr.Zero, IntPtr.Zero);
            Shutdown();
            return;
        }

        _window = new MainWindow();
        MainWindow = _window;
        _window.Show();

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Token Tracker", null, (_, _) => ShowWindow());
        menu.Items.Add("Refresh now", null, async (_, _) => await _window.RefreshNowAsync());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApplication());

        _trayIcon = new Forms.NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Token Tracker",
            Visible = true,
            ContextMenuStrip = menu
        };
        _trayIcon.DoubleClick += (_, _) => ShowWindow();
    }

    public void ShowWindow()
    {
        if (_window is null)
        {
            return;
        }

        _window.Show();
        _window.ShowInTaskbar = true;
        _window.WindowState = WindowState.Normal;
        _window.Activate();
    }

    public void HideWindow()
    {
        if (_window is null)
        {
            return;
        }

        _window.ShowInTaskbar = false;
        _window.Hide();
        _trayIcon?.ShowBalloonTip(
            1500,
            "Token Tracker is still running",
            "Usage updates will continue in the background.",
            Forms.ToolTipIcon.Info);
    }

    public void UpdateTrayText(string text)
    {
        if (_trayIcon is not null)
        {
            _trayIcon.Text = text.Length <= 63 ? text : text[..63];
        }
    }

    public void ExitApplication()
    {
        IsExiting = true;
        _window?.Close();
        _trayIcon?.Dispose();
        _trayIcon = null;
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _trayIcon?.Dispose();
        _instanceMutex?.Dispose();
        base.OnExit(e);
    }
}
