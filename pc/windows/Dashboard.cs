using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
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
    private readonly string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
    private readonly WebView2 web = new WebView2();
    private readonly Label loading = new Label();
    private string origin;
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
            int port = 18788; int configured;
            if (Int32.TryParse(Environment.GetEnvironmentVariable("RMDEX_PC_PORT"), out configured) && configured > 0 && configured < 65536) port = configured;
            origin = "http://127.0.0.1:" + port;
            if (!await Task.Run(() => Ready())) {
                var node = Environment.GetEnvironmentVariable("RMDEX_NODE");
                if (String.IsNullOrWhiteSpace(node)) node = "node.exe";
                var info = new ProcessStartInfo(node, "--import tsx pc/server.ts");
                info.WorkingDirectory = root; info.UseShellExecute = false; info.CreateNoWindow = true;
                var child = new Process(); child.StartInfo = info;
                Directory.CreateDirectory(Path.Combine(root, "work"));
                child.Start();
                bool ready = false;
                for (int i = 0; i < 60; i++) {
                    if (child.HasExited) break;
                    if (await Task.Run(() => Ready())) { ready = true; break; }
                    await Task.Delay(500);
                }
                if (!ready) throw new Exception("PC service did not start on " + origin + ". Check Node.js and the port.");
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
            loading.Text = "Unable to start rmdex PC.\n\n" + e.Message + "\n\nCheck work/pc-service.log and try again.";
            MessageBox.Show(this, e.Message, "rmdex PC", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
