using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
    private const string MutexName = "Local\\rmdex-pc";
    private const string PipeName = "rmdex-pc-instance";

    [STAThread] private static void Main() {
        var args = Environment.GetCommandLineArgs().Skip(1).ToArray();
        bool created;
        using (var mutex = new Mutex(true, MutexName, out created)) {
            if (!created) {
                ForwardToPrimary(args);
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Dashboard(args));
        }
    }

    private static void ForwardToPrimary(string[] args) {
        try {
            using (var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out)) {
                pipe.Connect(1500);
                using (var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true }) {
                    foreach (var arg in args) writer.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));
                    writer.WriteLine();
                }
            }
        } catch { }
    }
}

internal sealed class Dashboard : Form {
    private const string PipeName = "rmdex-pc-instance";
    private static readonly Regex SafeThreadId = new Regex("^[A-Za-z0-9_-]{1,256}$", RegexOptions.Compiled);
    private readonly string root = ResolveRoot();
    private readonly string[] launchArgs;
    private readonly WebView2 web = new WebView2();
    private readonly Label loading = new Label();
    private readonly NotifyIcon tray;
    private readonly CancellationTokenSource pipeCancellation = new CancellationTokenSource();
    private System.IO.Pipes.NamedPipeServerStream pipeServer;
    private System.Windows.Forms.Timer notificationTimer;
    private bool notificationBusy;
    private bool allowExit;
    private string pendingThreadId;
    private string pendingLaunchError;
    private string pendingBalloonThreadId;
    private string origin;
    private Process service;
    private bool ownsService;

    private sealed class LaunchTarget {
        public string ThreadId;
        public string Error;
    }

    private static bool HasPayload(string path) {
        return Directory.Exists(path)
            && File.Exists(Path.Combine(path, "pc", "server.ts"))
            && File.Exists(Path.Combine(path, "server", "index.ts"))
            && File.Exists(Path.Combine(path, "dist-pc", "index.html"))
            && File.Exists(Path.Combine(path, "package.json"));
    }

    private static string ResolveRoot() {
        var configured = Environment.GetEnvironmentVariable("RMDEX_PROJECT_ROOT");
        if (!String.IsNullOrWhiteSpace(configured) && HasPayload(configured)) return Path.GetFullPath(configured);
        var baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        if (HasPayload(baseDir)) return baseDir;
        var candidate = Path.GetFullPath(Path.Combine(baseDir, "..", ".."));
        return HasPayload(candidate) ? candidate : baseDir;
    }

    private string LogPath { get { return Path.Combine(root, "work", "pc-service.log"); } }

    private void Log(string message) {
        try {
            Directory.CreateDirectory(Path.Combine(root, "work"));
            File.AppendAllText(LogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine, Encoding.UTF8);
        } catch { }
    }

    public Dashboard(string[] args) {
        launchArgs = args ?? new string[0];
        Text = "rmdex PC";
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        var area = Screen.PrimaryScreen.WorkingArea;
        Width = Math.Min(720, area.Width); Height = Math.Min(960, area.Height);
        MinimumSize = new Size(Math.Min(600, area.Width), Math.Min(480, area.Height));
        StartPosition = FormStartPosition.CenterScreen;

        foreach (var arg in launchArgs) {
            var target = ParseLaunchArgument(arg);
            if (!String.IsNullOrEmpty(target.ThreadId)) pendingThreadId = target.ThreadId;
            else if (!String.IsNullOrEmpty(target.Error)) pendingLaunchError = target.Error;
        }

        loading.Dock = DockStyle.Fill; loading.TextAlign = ContentAlignment.MiddleCenter;
        loading.Text = "Starting rmdex PC..."; Controls.Add(loading);
        web.Dock = DockStyle.Fill; Controls.Add(web); web.Visible = false;
        tray = CreateTray();
        FormClosing += OnFormClosing;
        FormClosed += OnFormClosed;
        Shown += async delegate {
            if (!String.IsNullOrEmpty(pendingLaunchError)) MessageBox.Show(this, pendingLaunchError, "rmdex PC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            await InitializeAsync();
        };
        StartCommandPipe();
    }

    private NotifyIcon CreateTray() {
        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("打开 rmdex");
        open.Click += delegate { ShowFromTray(); };
        menu.Items.Add(new ToolStripSeparator());
        var start = menu.Items.Add("启动本机服务");
        start.Click += async delegate { await ControlServiceAsync("start"); };
        var stop = menu.Items.Add("暂停本机服务");
        stop.Click += async delegate { await ControlServiceAsync("stop"); };
        menu.Items.Add(new ToolStripSeparator());
        var exit = menu.Items.Add("退出 rmdex PC");
        exit.Click += delegate { allowExit = true; Close(); };
        var icon = Icon ?? SystemIcons.Application;
        var result = new NotifyIcon { Text = "rmdex PC", Icon = icon, ContextMenuStrip = menu, Visible = true };
        result.DoubleClick += delegate { ShowFromTray(); };
        result.BalloonTipClicked += delegate {
            var threadId = pendingBalloonThreadId;
            pendingBalloonThreadId = null;
            if (!String.IsNullOrEmpty(threadId)) NavigateToThread(threadId);
            ShowFromTray();
        };
        return result;
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e) {
        if (!allowExit && e.CloseReason == CloseReason.UserClosing) {
            e.Cancel = true;
            HideToTray();
        }
    }

    private void OnFormClosed(object sender, FormClosedEventArgs e) {
        if (notificationTimer != null) notificationTimer.Stop();
        if (notificationTimer != null) notificationTimer.Dispose();
        tray.Visible = false;
        tray.Dispose();
        pipeCancellation.Cancel();
        try { if (pipeServer != null) pipeServer.Dispose(); } catch { }
        if (ownsService && service != null && !service.HasExited && service.Id > 0) {
            try { Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + service.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false }); } catch { }
        }
    }

    private void HideToTray() {
        ShowInTaskbar = false;
        Hide();
    }

    private void ShowFromTray() {
        ShowInTaskbar = true;
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
    }

    private void StartCommandPipe() {
        Task.Run(async delegate {
            while (!pipeCancellation.IsCancellationRequested) {
                var pipeFailed = false;
                try {
                    using (var pipe = new NamedPipeServerStream(PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
                        pipeServer = pipe;
                        await pipe.WaitForConnectionAsync();
                        var args = new List<string>();
                        using (var reader = new StreamReader(pipe, Encoding.UTF8)) {
                            string line;
                            while ((line = await reader.ReadLineAsync()) != null && line.Length > 0) {
                                try { args.Add(Encoding.UTF8.GetString(Convert.FromBase64String(line))); } catch { }
                            }
                        }
                        if (args.Count > 0 && !IsDisposed) BeginInvoke((Action)delegate { HandleLaunchArguments(args.ToArray()); });
                    }
                } catch { pipeFailed = true; }
                finally { pipeServer = null; }
                if (pipeFailed && !pipeCancellation.IsCancellationRequested) await Task.Delay(250);
            }
        });
    }

    private static LaunchTarget ParseLaunchArgument(string value) {
        if (String.IsNullOrWhiteSpace(value)) return new LaunchTarget();
        Uri uri;
        if (Uri.TryCreate(value, UriKind.Absolute, out uri) && (String.Equals(uri.Scheme, "codex", StringComparison.OrdinalIgnoreCase) || String.Equals(uri.Scheme, "rmdex", StringComparison.OrdinalIgnoreCase))) {
            if (!String.Equals(uri.Host, "thread", StringComparison.OrdinalIgnoreCase)) return new LaunchTarget { Error = "不支持的桌面链接，只能打开 codex://thread/<会话 ID>。" };
            var id = Uri.UnescapeDataString(uri.AbsolutePath.Trim('/'));
            if (id.Contains("/")) return new LaunchTarget { Error = "桌面链接中的会话 ID 无效。" };
            return SafeThreadId.IsMatch(id) ? new LaunchTarget { ThreadId = id } : new LaunchTarget { Error = "桌面链接中的会话 ID 无效。" };
        }
        if (!String.Equals(Path.GetExtension(value), ".rmdex", StringComparison.OrdinalIgnoreCase)) return new LaunchTarget();
        try {
            var info = new FileInfo(value);
            if (!info.Exists) return new LaunchTarget { Error = "找不到要打开的 .rmdex 文件。" };
            if (info.Length > 128 * 1024) return new LaunchTarget { Error = ".rmdex 文件过大，无法打开。" };
            var parsed = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(info.FullName, Encoding.UTF8)) as Dictionary<string, object>;
            var type = parsed == null || !parsed.ContainsKey("type") ? "" : Convert.ToString(parsed["type"]);
            var threadId = parsed == null || !parsed.ContainsKey("threadId") ? "" : Convert.ToString(parsed["threadId"]);
            if (type != "rmdex-session" || !SafeThreadId.IsMatch(threadId ?? "")) return new LaunchTarget { Error = ".rmdex 文件格式无效，需要包含有效的 rmdex 会话 ID。" };
            return new LaunchTarget { ThreadId = threadId };
        } catch (Exception error) {
            return new LaunchTarget { Error = "无法读取 .rmdex 文件：" + error.Message };
        }
    }

    private void HandleLaunchArguments(string[] args) {
        foreach (var arg in args ?? new string[0]) {
            var target = ParseLaunchArgument(arg);
            if (!String.IsNullOrEmpty(target.ThreadId)) {
                pendingLaunchError = null;
                NavigateToThread(target.ThreadId);
                return;
            }
            if (!String.IsNullOrEmpty(target.Error)) {
                MessageBox.Show(this, target.Error, "rmdex PC", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }
        ShowFromTray();
    }

    private void NavigateToThread(string threadId) {
        if (!SafeThreadId.IsMatch(threadId ?? "")) return;
        if (web.CoreWebView2 == null || String.IsNullOrEmpty(origin)) { pendingThreadId = threadId; return; }
        ShowFromTray();
        web.Source = new Uri(origin + "/?openThread=" + Uri.EscapeDataString(threadId));
    }

    private bool Ready() {
        try {
            var request = (HttpWebRequest)WebRequest.Create(origin + "/pc-api/status");
            request.Timeout = 2500; request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) {
                var body = reader.ReadToEnd();
                return response.StatusCode == HttpStatusCode.OK && body.Contains("\"phase\"") && body.Contains("\"appServer\"");
            }
        } catch { return false; }
    }

    private async Task InitializeAsync() {
        try {
            Log("Launching PC service. root=" + root + ", payload=" + HasPayload(root));
            if (!HasPayload(root)) throw new Exception("安装包缺少 PC 服务文件：" + root + "。请重新安装最新版本。");
            var port = 18788;
            int configured;
            if (Int32.TryParse(Environment.GetEnvironmentVariable("RMDEX_PC_PORT"), out configured) && configured > 0 && configured < 65536) port = configured;
            origin = "http://127.0.0.1:" + port;
            if (!await Task.Run(() => Ready())) {
                var node = Environment.GetEnvironmentVariable("RMDEX_NODE");
                if (String.IsNullOrWhiteSpace(node)) {
                    var bundled = Path.Combine(root, "runtime", "node.exe");
                    if (File.Exists(bundled)) node = bundled;
                }
                if (String.IsNullOrWhiteSpace(node)) node = "node.exe";
                Directory.CreateDirectory(Path.Combine(root, "work"));
                Log("node=" + node + ", cwd=" + root + ", entry=pc/server.ts");
                var info = new ProcessStartInfo(node, "--import tsx pc/server.ts");
                info.WorkingDirectory = root; info.UseShellExecute = false; info.CreateNoWindow = true;
                info.RedirectStandardOutput = true; info.RedirectStandardError = true;
                var child = new Process(); child.StartInfo = info;
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("stdout: " + e.Data); };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("stderr: " + e.Data); };
                service = child;
                child.Start(); ownsService = true;
                child.BeginOutputReadLine(); child.BeginErrorReadLine();
                var ready = false;
                for (var i = 0; i < 60; i++) {
                    if (child.HasExited) break;
                    if (await Task.Run(() => Ready())) { ready = true; break; }
                    await Task.Delay(500);
                }
                if (!ready) {
                    var exit = child.HasExited ? " process exited with code " + child.ExitCode + "." : "";
                    Log("PC service did not become ready on " + origin + "." + exit);
                    throw new Exception("PC service did not start on " + origin + ". See " + LogPath + "." + exit);
                }
                Log("PC service ready on " + origin);
            }
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rmdex", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(environment);
            web.ZoomFactor = 0.75;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) {
                e.Handled = true;
                if (!String.IsNullOrEmpty(e.Uri)) HandleLaunchArguments(new[] { e.Uri });
            };
            web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                Uri target;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target)) { e.Cancel = true; return; }
                if (target.Scheme == "codex" || target.Scheme == "rmdex") { e.Cancel = true; HandleLaunchArguments(new[] { e.Uri }); return; }
                if (target.GetLeftPart(UriPartial.Authority) != origin) e.Cancel = true;
            };
            var startUrl = origin + "/";
            var firstThread = pendingThreadId;
            pendingThreadId = null;
            if (!String.IsNullOrEmpty(firstThread)) startUrl += "?openThread=" + Uri.EscapeDataString(firstThread);
            web.Source = new Uri(startUrl); web.Visible = true; loading.Visible = false;
            notificationTimer = new System.Windows.Forms.Timer { Interval = 5000 };
            notificationTimer.Tick += async delegate { await PollNotificationsAsync(); };
            notificationTimer.Start();
        } catch (Exception e) {
            Log("fatal: " + e);
            loading.Text = "Unable to start rmdex PC.\n\n" + e.Message + "\n\nCheck work/pc-service.log and try again.";
            MessageBox.Show(this, e.Message, "rmdex PC", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task ControlServiceAsync(string action) {
        try {
            var request = (HttpWebRequest)WebRequest.Create(origin + "/pc-api/" + action);
            request.Method = "POST"; request.ContentType = "application/json"; request.ContentLength = 2; request.Proxy = null;
            using (var stream = await request.GetRequestStreamAsync()) { var bytes = Encoding.UTF8.GetBytes("{}"); await stream.WriteAsync(bytes, 0, bytes.Length); }
            using (var response = (HttpWebResponse)await request.GetResponseAsync()) { }
        } catch (Exception error) { Log("control " + action + " failed: " + error.Message); }
    }

    private async Task PollNotificationsAsync() {
        if (notificationBusy || String.IsNullOrEmpty(origin)) return;
        notificationBusy = true;
        try {
            var request = (HttpWebRequest)WebRequest.Create(origin + "/pc-api/notifications");
            request.Timeout = 5000; request.Proxy = null;
            using (var response = (HttpWebResponse)await request.GetResponseAsync())
            using (var reader = new StreamReader(response.GetResponseStream())) {
                var parsed = new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
                var events = parsed == null || !parsed.ContainsKey("data") ? null : parsed["data"] as object[];
                if (events == null) return;
                foreach (var item in events) {
                    var data = item as Dictionary<string, object>;
                    if (data == null) continue;
                    var title = data.ContainsKey("title") ? Convert.ToString(data["title"]) : "rmdex 任务提醒";
                    var body = data.ContainsKey("body") ? Convert.ToString(data["body"]) : "任务状态已更新，点击查看详情";
                    var threadId = data.ContainsKey("threadId") ? Convert.ToString(data["threadId"]) : "";
                    if (!String.IsNullOrEmpty(threadId)) pendingBalloonThreadId = threadId;
                    tray.ShowBalloonTip(6000, title, body, ToolTipIcon.Info);
                }
            }
        } catch (Exception error) { Log("notification poll failed: " + error.Message); }
        finally { notificationBusy = false; }
    }
}
