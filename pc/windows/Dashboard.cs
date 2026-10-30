using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
    [STAThread] private static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Dashboard());
    }
}
internal sealed class Dashboard : Form {
    private readonly string root = ResolveRoot();
    private readonly WebView2 web = new WebView2();
    private readonly Label loading = new Label();
    private string origin;
    private Process service;
    private bool ownsService;
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
    private string LogPath {
        get { return Path.Combine(root, "work", "pc-service.log"); }
    }
    private void Log(string message) {
        try {
            Directory.CreateDirectory(Path.Combine(root, "work"));
            File.AppendAllText(LogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine, Encoding.UTF8);
        } catch { }
    }
    public Dashboard() {
        Text = "rmdex PC";
        var area = Screen.PrimaryScreen.WorkingArea;
        Width = Math.Min(720, area.Width); Height = Math.Min(960, area.Height);
        MinimumSize = new Size(Math.Min(600, area.Width), Math.Min(480, area.Height));
        StartPosition = FormStartPosition.CenterScreen;
        loading.Dock = DockStyle.Fill; loading.TextAlign = ContentAlignment.MiddleCenter;
        loading.Text = "Starting rmdex PC..."; Controls.Add(loading);
        web.Dock = DockStyle.Fill; Controls.Add(web); web.Visible = false;
        Shown += async delegate { await InitializeAsync(); };
        FormClosed += delegate {
            if (ownsService && service != null && !service.HasExited && service.Id > 0) {
                try { Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + service.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false }); } catch { }
            }
        };
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
            int port = 18788; int configured;
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
                child.Start();
                ownsService = true;
                child.BeginOutputReadLine(); child.BeginErrorReadLine();
                bool ready = false;
                for (int i = 0; i < 60; i++) {
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
            string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rmdex", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(environment);
            web.ZoomFactor = 0.75;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
            web.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                Uri target; if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target) || target.GetLeftPart(UriPartial.Authority) != origin) e.Cancel = true;
            };
            web.Source = new Uri(origin + "/"); web.Visible = true; loading.Visible = false;
        } catch (Exception e) {
            Log("fatal: " + e);
            loading.Text = "Unable to start rmdex PC.\n\n" + e.Message + "\n\nCheck work/pc-service.log and try again.";
            MessageBox.Show(this, e.Message, "rmdex PC", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
