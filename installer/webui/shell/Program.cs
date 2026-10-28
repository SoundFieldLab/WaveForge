// WaveForge 安装器 WebView2 壳（目标 .NET Framework 4.8，系统自带 csc 可编译）
// 职责：无边框窗口 + WebView2 承载 ui/ + JSON IPC + 目录选择 + 启动静默安装 + 进度轮询。
// NSIS 安装逻辑仍是权威（electron-builder install Section），本程序只负责可见界面。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace WaveForge.SetupUI
{
    internal static class Program
    {
        internal static bool Autodemo;
        internal static string AutodemoMode = "1";
        internal static string LangOverride = "";

        [STAThread]
        private static int Main(string[] args)
        {
            bool preview = Array.IndexOf(args, "--preview") >= 0;
            bool uninstall = Array.IndexOf(args, "--uninstall") >= 0;
            Autodemo = Array.Exists(args, delegate (string a) { return a == "--autodemo" || a.StartsWith("--autodemo="); })
                || Environment.GetEnvironmentVariable("WF_SETUP_AUTODEMO") == "1";
            if (Autodemo)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i].StartsWith("--autodemo=")) AutodemoMode = args[i].Substring("--autodemo=".Length);
                }
            }
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--lang" && i < args.Length - 1) LangOverride = args[i + 1];
                else if (args[i].StartsWith("--lang=")) LangOverride = args[i].Substring("--lang=".Length);
            }
            string bootstrapPath = null;
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--bootstrap") bootstrapPath = args[i + 1];
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            SetupWindow win = new SetupWindow(preview, bootstrapPath, uninstall);
            Application.Run(win);
            return win.ExitCode;
        }
    }

    internal sealed class SetupWindow : Form
    {
        private const int WM_NCHITTEST = 0x0084;
        private const int HTCLIENT = 1;
        private const int HTCAPTION = 2;
        private const int WM_NCLBUTTONDBLCLK = 0x00A3;

        private readonly bool _preview;
        private readonly bool _uninstall;
        private readonly string _bootstrapPath;
        private Dictionary<string, string> _bs = new Dictionary<string, string>();

        public static void Log(string s)
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "waveforge-setup-ui.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + "\r\n", Encoding.UTF8); }
            catch { }
        }

        // NSIS FileEncoding UTF16LE（可能无 BOM）/UTF-8/ANSI 兼容读取
        private static string[] ReadBootstrapLines(string path)
        {
            byte[] bytes = File.ReadAllBytes(path);
            Encoding enc = Encoding.UTF8;
            int start = 0;
            if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) { enc = Encoding.Unicode; start = 2; }
            else if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) { start = 3; }
            else
            {
                try { new UTF8Encoding(false, true).GetCharCount(bytes); }
                catch { enc = Encoding.Default; }
                if (bytes.Length >= 2 && bytes[0] == 0x50 && bytes[1] == 0x00) { enc = Encoding.Unicode; start = 0; }
            }
            string text = enc.GetString(bytes, start, bytes.Length - start);
            return text.Replace("\r\n", "\n").Split('\n');
        }

        private CoreWebView2Environment _env;
        private CoreWebView2Controller _controller;
        private CoreWebView2 _web;
        private JavaScriptSerializer _json = new JavaScriptSerializer();
        private Queue<Action> _pendingMessages = new Queue<Action>();

        private ProcessEx _installer;
        private System.Windows.Forms.Timer _poll;
        private long _lastBytes;
        private DateTime _lastTick;
        private int _exitCode;

        public int ExitCode { get { return _exitCode; } }

        internal const int ExitCancelled = 32; // 用户在卸载确认页点了取消：NSIS 收到后跳过收尾删除

        public SetupWindow(bool preview, string bootstrapPath) : this(preview, bootstrapPath, false) { }

        public SetupWindow(bool preview, string bootstrapPath, bool uninstall)
        {
            _preview = preview;
            _bootstrapPath = bootstrapPath;
            _uninstall = uninstall;

            Text = "WaveForge 安装";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(960, 640);
            BackColor = Color.FromArgb(15, 23, 42);
            DoubleBuffered = true;
            KeyPreview = true;

            AllowDrop = false;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;

            // 任务栏 / Alt-Tab / 窗口图标：exe 已通过 /win32icon 嵌入 setup-icon.ico
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Log("OnLoad dpiAware=" + Native.GetDpiAwareness());
            Native.RoundCorners(Handle);

            // 任务栏 / Alt-Tab 标题：产品名 + Setup（bootstrap 此时可读）
            LoadBootstrapFile();
            Text = Bs("PRODUCT", "WaveForge 澜音工坊") + (_uninstall ? " Uninstall" : " Setup");
            _mode = _uninstall ? "uninstall" : "install";

            // WebView2 的 CSS 视口 = 物理尺寸 ÷ DPI 缩放；按窗口 DPI 反推物理尺寸，
            // 保证任何缩放比例下 CSS 视口都是 960×640（超出工作区则收紧）
            float scale = Native.GetDpiForWindowSafe(Handle) / 96f;
            if (scale < 1f) scale = 1f;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int cw = (int)(960 * scale), ch = (int)(640 * scale);
            if (cw > wa.Width - 24) cw = wa.Width - 24;
            if (ch > wa.Height - 24) ch = wa.Height - 24;
            ClientSize = new Size(cw, ch);
            Location = new Point(wa.Left + (wa.Width - cw) / 2, wa.Top + (wa.Height - ch) / 2);
            Log("OnLoad client=" + ClientSize.Width + "x" + ClientSize.Height + " scale=" + scale.ToString("F2"));

            InitWebViewAsync();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (_poll != null) { _poll.Stop(); _poll.Dispose(); }
            base.OnFormClosed(e);
        }

        // 顶部拖动（WebView2 app-region 由 Settings 开启，这里做兜底）
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result == HTCLIENT)
                {
                    Point p = PointToClient(new Point(m.LParam.ToInt32() & 0xFFFF, m.LParam.ToInt32() >> 16));
                    if (p.Y < 52 && p.X < ClientSize.Width - 100) m.Result = (IntPtr)HTCAPTION;
                }
                return;
            }
            if (m.Msg == WM_NCLBUTTONDBLCLK) { return; }
            base.WndProc(ref m);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (_controller != null) _controller.Bounds = ClientRectangle;
        }

        protected override void OnLocationChanged(EventArgs e)
        {
            base.OnLocationChanged(e);
            if (_controller != null) _controller.NotifyParentWindowPositionChanged();
        }

        private async void InitWebViewAsync()
        {
            try
            {
                _wv2Version = Native.GetWebView2Version();
                string userData = Path.Combine(Path.GetTempPath(), "waveforge-setup-webview");
                _env = await CoreWebView2Environment.CreateAsync(null, userData);
                _controller = await _env.CreateCoreWebView2ControllerAsync(Handle);
                _controller.Bounds = ClientRectangle;
                _web = _controller.CoreWebView2;

                _web.Settings.AreDevToolsEnabled = _preview;
                _web.Settings.IsZoomControlEnabled = false;
                _web.Settings.IsStatusBarEnabled = false;
                _web.Settings.AreDefaultContextMenusEnabled = false;
                try
                {
                    // 新版运行时才有的 app-region 支持；没有也无妨，WndProc 里有拖动兜底
                    System.Reflection.PropertyInfo ncr = _web.Settings.GetType().GetProperty("IsNonClientRegionSupportEnabled");
                    if (ncr != null) ncr.SetValue(_web.Settings, true, null);
                }
                catch { }

                _web.WebMessageReceived += OnWebMessage;
                string uiDir = ResolveUiDir();
                string html = Path.Combine(uiDir, "index.html");
                Log("navigate " + html + " exists=" + File.Exists(html));
                Uri uri = new Uri(html);
                // 加时间戳参数防 WebView2 缓存旧的 file:// 脚本
                string url = uri.AbsoluteUri + "?v=" + DateTime.UtcNow.Ticks;
                // 卸载模式的自动执行走 bootstrap.autodemo（不经 URL，避免触发安装自动化）
                if (Program.Autodemo && !_uninstall) url += "&autodemo=" + Uri.EscapeDataString(Program.AutodemoMode);
                if (Program.LangOverride != "") url += "&lang=" + Uri.EscapeDataString(Program.LangOverride);
                url += "&mode=" + _mode;
                Log("navigate url: " + url);
                _web.Navigate(url);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "安装界面初始化失败（未找到 WebView2 运行时）：" + ex.Message +
                    "\n\n请安装 Microsoft Edge WebView2 运行时后重试。",
                    "WaveForge 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
                _exitCode = 3;
                Close();
            }
        }

        private string ResolveUiDir()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string[] candidates;
            if (!string.IsNullOrEmpty(_bootstrapPath))
            {
                candidates = new[] {
                    Path.Combine(Path.GetDirectoryName(_bootstrapPath), "ui"),
                    Path.Combine(baseDir, "ui"),
                    baseDir,
                };
            }
            else
            {
                candidates = new[] { Path.Combine(baseDir, "ui"), baseDir };
            }
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(Path.Combine(candidates[i], "index.html"))) return candidates[i];
            }
            return baseDir;
        }

        // ---------- IPC ----------
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> msg;
            try { msg = _json.Deserialize<Dictionary<string, object>>(e.TryGetWebMessageAsString()); }
            catch (Exception ex) { Log("msg parse fail: " + ex.Message); return; }
            if (msg == null) return;
            object typeObj; msg.TryGetValue("type", out typeObj);
            string type = typeObj as string;
            Log("msg " + type + " " + (msg.ContainsKey("method") ? msg["method"].ToString() : ""));
            if (type == "event") return;

            object idObj, methodObj, argsObj;
            msg.TryGetValue("id", out idObj);
            msg.TryGetValue("method", out methodObj);
            msg.TryGetValue("args", out argsObj);
            string method = methodObj as string ?? "";
            Dictionary<string, object> rpcArgs = argsObj as Dictionary<string, object> ?? new Dictionary<string, object>();

            if (type != "invoke")
            {
                Dispatch(method, rpcArgs);
                return;
            }
            int id = Convert.ToInt32(idObj ?? 0);
            try
            {
                object data = DispatchWithResult(method, rpcArgs);
                Post(new { type = "result", id = id, ok = true, data = data });
            }
            catch (Exception ex)
            {
                Post(new { type = "result", id = id, ok = false, error = ex.Message });
            }
        }

        private void Post(object payload)
        {
            if (_web == null) { _pendingMessages.Enqueue(delegate { Post(payload); }); return; }
            while (_pendingMessages.Count > 0) _pendingMessages.Dequeue()();
            string json = _json.Serialize(payload);
            Log("post " + (json.Length > 140 ? json.Substring(0, 140) + "…" : json));
            _web.PostWebMessageAsJson(json);
        }

        private void PostEvent(string name, object data)
        {
            Post(new { type = "event", name = name, data = data });
        }

        private object DispatchWithResult(string method, Dictionary<string, object> a)
        {
            switch (method)
            {
                case "bootstrap": return DoBootstrap();
                case "scanUninstall": return DoScanUninstall();
                case "runUninstall": return DoRunUninstall(a);
                case "killApp": return DoKillApp();
                case "pickFolder": return DoPickFolder(ArgStr(a, "current"));
                case "getDriveSpace": return DoDriveSpace(ArgStr(a, "path"));
                case "probeWritable": return DoProbeWritable(ArgStr(a, "dir"));
                case "startInstall": return DoStartInstall(a);
                case "cancelInstall": return DoCancelInstall();
                case "finish": _uninstallFinished = true; return DoFinish(a);
                case "openFolder": DoOpenFolder(ArgStr(a, "dir")); return null;
                case "listDir": return DoListDir(ArgStr(a, "path"));
                case "createDir": return DoCreateDir(ArgStr(a, "path"), ArgStr(a, "name"));
                case "log": Log("[js] " + ArgStr(a, "msg")); return null;
                case "minimize": WindowState = FormWindowState.Minimized; return null;
                case "close": if (_uninstall && !_uninstallFinished) _exitCode = ExitCancelled; Close(); return null;
                default: throw new InvalidOperationException("unknown method: " + method);
            }
        }

        private void Dispatch(string method, Dictionary<string, object> a)
        {
            try { DispatchWithResult(method, a); } catch { }
        }

        private static string ArgStr(Dictionary<string, object> a, string key)
        {
            object v; a.TryGetValue(key, out v);
            return v == null ? null : v.ToString();
        }

        // ---------- bootstrap ----------
        private string _wv2Version;
        private string _mode = "install"; // install | uninstall
        private bool _uninstallFinished; // 卸载流程走完（完成页关闭时置位），此时 close 才算正常收尾

        private static string OsLabel()
        {
            int build = Environment.OSVersion.Version.Build;
            return "Windows " + (build >= 22000 ? "11" : "10") + (Environment.Is64BitOperatingSystem ? " · 64 位" : "");
        }

        private object DoBootstrap()
        {
            if (_preview)
            {
                return new
                {
                    mode = "preview",
                    productName = "WaveForge 澜音工坊",
                    version = "preview",
                    appExe = "WaveForge.exe",
                    estMb = 1240,
                    dirCurrent = "D:\\WaveForge",
                    dirAll = "C:\\Program Files\\WaveForge 澜音工坊",
                    scope = "current",
                    priorVer = "",
                    sysOs = OsLabel(),
                    webview2 = Native.GetWebView2Version(),
                    uninstall = _uninstall,
                    drives = DriveList(),
                };
            }
            LoadBootstrapFile();
            string scope;
            if (!_bs.TryGetValue("SCOPE", out scope)) scope = "current";
            string ver;
            if (!_bs.TryGetValue("VERSION", out ver)) ver = "";
            string appExe;
            if (!_bs.TryGetValue("APP_EXE", out appExe)) appExe = "app.exe";
            string product = Environment.GetEnvironmentVariable("WF_PRODUCT");
            if (string.IsNullOrEmpty(product)) product = Bs("PRODUCT", "WaveForge");
            int estMb = ParseInt(_bs.ContainsKey("EST_MB") ? _bs["EST_MB"] : "0");
            string dirCur, dirAll;
            _bs.TryGetValue("DIR_CURRENT", out dirCur);
            dirAll = Environment.GetEnvironmentVariable("WF_DIR_ALL");
            if (string.IsNullOrEmpty(dirAll)) _bs.TryGetValue("DIR_ALL", out dirAll);
            string priorVer;
            _bs.TryGetValue("PRIOR_VER", out priorVer);
            return new
            {
                mode = "real",
                productName = product,
                version = ver,
                appExe = appExe,
                estMb = estMb,
                dirCurrent = dirCur,
                dirAll = dirAll,
                scope = scope,
                priorVer = priorVer == null ? "" : priorVer,
                sysOs = OsLabel(),
                webview2 = _wv2Version == null ? "" : _wv2Version,
                uninstall = _uninstall,
                autodemo = Environment.GetEnvironmentVariable("WF_SETUP_AUTODEMO") == "1" || Program.Autodemo,
                autodemoDelete = Environment.GetEnvironmentVariable("WF_SETUP_AUTODEMO") == "delete",
                drives = DriveList(),
            };
        }

        private void LoadBootstrapFile()
        {
            _bs = new Dictionary<string, string>();
            if (string.IsNullOrEmpty(_bootstrapPath) || !File.Exists(_bootstrapPath)) return;
            foreach (string line in ReadBootstrapLines(_bootstrapPath))
            {
                int idx = line.IndexOf('=');
                if (idx <= 0) continue;
                _bs[line.Substring(0, idx).Trim()] = line.Substring(idx + 1);
            }
            Log("bootstrap parsed: " + string.Join(",", new List<string>(_bs.Keys).ToArray()));
        }

        private static object[] DriveList()
        {
            List<object> list = new List<object>();
            foreach (DriveInfo d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    if (d.DriveType != DriveType.Fixed) continue;
                    list.Add(new
                    {
                        root = d.Name.TrimEnd('\\'),
                        free = (long)(d.AvailableFreeSpace / 1048576.0),
                        total = (long)(d.TotalSize / 1048576.0),
                    });
                }
                catch { }
            }
            return list.ToArray();
        }

        // ---------- 文件夹 / 磁盘 ----------
        private object DoPickFolder(string current)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.ShowNewFolderButton = true;
                try { if (!string.IsNullOrEmpty(current)) dlg.SelectedPath = Path.GetFullPath(current); } catch { }
                dlg.Description = "选择 " + Bs("PRODUCT", "WaveForge") + " 的安装目录";
                if (dlg.ShowDialog(this) == DialogResult.OK) return dlg.SelectedPath;
                return null;
            }
        }

        private string Bs(string key, string fallback)
        {
            string v;
            return _bs.TryGetValue(key, out v) && !string.IsNullOrEmpty(v) ? v : fallback;
        }

        private object DoDriveSpace(string path)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(path));
                if (string.IsNullOrEmpty(root)) return null;
                DriveInfo d = new DriveInfo(root);
                if (!d.IsReady) return new { free = 0L, total = 0L };
                return new
                {
                    free = (long)(d.AvailableFreeSpace / 1048576.0),
                    total = (long)(d.TotalSize / 1048576.0),
                };
            }
            catch { return null; }
        }

        private object DoProbeWritable(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".wf-write-probe-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".tmp");
                File.WriteAllText(probe, "probe");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }

        private void DoOpenFolder(string dir)
        {
            try { System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + dir + "\""); } catch { }
        }

        // 自绘目录浏览弹窗：列出 path 的子文件夹；path 为空表示“此电脑”层（由前端用驱动列表渲染）
        private object DoListDir(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return new { dirs = new object[0], root = true };
            try
            {
                string full = Path.GetFullPath(path);
                if (!Directory.Exists(full)) return new { dirs = new object[0], root = false, missing = true };
                var dirs = Directory.EnumerateDirectories(full)
                    .Select(d => Path.GetFileName(d) ?? d)
                    .Where(n => n.Length > 0)
                    .OrderBy(n => n, StringComparer.CurrentCultureIgnoreCase)
                    .Take(800)
                    .ToArray();
                return new { dirs = dirs, root = false };
            }
            catch (Exception ex) { return new { dirs = new object[0], root = false, error = ex.Message }; }
        }

        private object DoCreateDir(string path, string name)
        {
            if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(name))
                throw new InvalidOperationException("目录或名称为空。");
            if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidOperationException("名称包含不允许的字符。");
            Directory.CreateDirectory(Path.Combine(path, name));
            return true;
        }

        // ---------- 安装 ----------
        private object DoStartInstall(Dictionary<string, object> a)
        {
            if (_preview)
            {
                SimulateInstall();
                return true;
            }
            string dir = ArgStr(a, "dir");
            // 安装路径防御：拒绝盘符根（C:\ 等）。装到根目录会把应用文件与系统/用户
            // 文件混在同一层，卸载时 SafeDeleteDir 也因"拒绝删除非本软件路径"留下残骸。
            if (!string.IsNullOrWhiteSpace(dir))
            {
                string fullDir = Path.GetFullPath(dir).TrimEnd('\\');
                if (string.Equals(fullDir, Path.GetPathRoot(fullDir)?.TrimEnd('\\') ?? "", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("安装路径不能是盘符根目录，请选择一个子文件夹（如 D:\\WaveForge）。");
            }
            string scope = ArgStr(a, "scope") ?? "current";
            bool desktop = true;
            object deskObj; a.TryGetValue("desktopShortcut", out deskObj);
            if (deskObj is bool) desktop = (bool)deskObj;

            string setupExe = Bs("EXEPATH", null);
            if (string.IsNullOrEmpty(setupExe) || !File.Exists(setupExe))
                throw new InvalidOperationException("找不到安装程序本体。");

            StringBuilder sb = new StringBuilder("/S /wfgo");
            if (scope == "all") sb.Append(" /allusers");
            if (!desktop) sb.Append(" /nodesktop");
            sb.Append(" /D=").Append(dir); // /D 必须是最后一个参数，不加引号

            System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo();
            psi.FileName = setupExe;
            psi.Arguments = sb.ToString();
            psi.UseShellExecute = true;
            if (scope == "all") psi.Verb = "runas";
            try
            {
                _installer = new ProcessEx(System.Diagnostics.Process.Start(psi));
                _installDir = dir;
            }
            catch (System.ComponentModel.Win32Exception wex)
            {
                if (wex.NativeErrorCode == 1223) throw new InvalidOperationException("elevate-cancelled");
                throw;
            }

            _lastBytes = 0;
            _lastTick = DateTime.Now;
            _poll = new System.Windows.Forms.Timer();
            _poll.Interval = 500;
            _poll.Tick += PollInstall;
            _poll.Start();
            return true;
        }

        private void SimulateInstall()
        {
            int est = 1240;
            DateTime t0 = DateTime.Now;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 180;
            timer.Tick += delegate
            {
                double sec = (DateTime.Now - t0).TotalSeconds;
                double frac = Math.Min(1.0, sec / 12.0);
                double eased = frac < 0.9 ? Math.Min(0.94, frac * 1.04) : 0.94 + (frac - 0.9) / 0.1 * 0.06;
                int mb = Math.Max(0, Math.Min(est, (int)Math.Round(est * eased)));
                PostEvent("update", new
                {
                    phase = frac >= 1 ? "done" : "extract",
                    percent = Math.Min(100, (int)Math.Round(eased * 100)),
                    copiedMb = mb,
                    totalMb = est,
                    speedMbps = (mb / Math.Max(sec, 0.001)).ToString("F0"),
                });
                if (frac >= 1) { timer.Stop(); timer.Dispose(); }
            };
            timer.Start();
        }

        private void PollInstall(object sender, EventArgs e)
        {
            if (_installer == null) return;
            bool exited = _installer.Process.HasExited;
            long bytes = DirSize(_installDir);
            int estMb = ParseInt(Bs("EST_MB", "0"));
            long totalKb = estMb * 1024L;
            double frac = totalKb > 0 ? Math.Min(0.96, (double)bytes / totalKb) : 0.1;
            int percent = (int)Math.Round(frac * 100);
            double dsec = (DateTime.Now - _lastTick).TotalSeconds;
            long db = bytes - _lastBytes;
            double speed = dsec > 0 ? (db / 1048576.0) / dsec : 0;
            _lastBytes = bytes;
            _lastTick = DateTime.Now;

            if (exited)
            {
                _poll.Stop();
                int code = _installer.Process.ExitCode;
                string appExe = Bs("APP_EXE", "app.exe");
                bool ok = code == 0 && File.Exists(Path.Combine(_installDir, appExe));
                PostEvent("update", new
                {
                    phase = ok ? "done" : "error",
                    percent = ok ? 100 : percent,
                    copiedMb = (long)(bytes / 1048576.0),
                    totalMb = estMb,
                    speedMbps = "",
                });
                _exitCode = ok ? 0 : 4;
                return;
            }
            PostEvent("update", new
            {
                phase = "extract",
                percent = percent,
                copiedMb = (long)(bytes / 1048576.0),
                totalMb = estMb,
                speedMbps = speed > 0.5 ? speed.ToString("F0") : "",
            });
        }

        private string _installDir;

        private object DoCancelInstall()
        {
            if (_poll != null) _poll.Stop();
            if (_installer != null && !_installer.Process.HasExited)
            {
                try
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = "/PID " + _installer.Process.Id + " /T /F",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                    });
                }
                catch { }
            }
            return true;
        }

        private object DoFinish(Dictionary<string, object> a)
        {
            if (!_preview)
            {
                object launchObj; a.TryGetValue("launch", out launchObj);
                if (launchObj is bool && (bool)launchObj)
                {
                    try
                    {
                        string exe = Path.Combine(_installDir, Bs("APP_EXE", "app.exe"));
                        if (File.Exists(exe))
                        {
                            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                            {
                                FileName = exe,
                                WorkingDirectory = _installDir,
                                UseShellExecute = true,
                            });
                        }
                    }
                    catch { }
                }
            }
            _exitCode = 0;
            Close();
            return null;
        }

        private static int ParseInt(string s)
        {
            int v; return int.TryParse(s, out v) ? v : 0;
        }

        private static long DirSize(string dir)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return 0;
            long total = 0;
            Stack<string> stack = new Stack<string>();
            stack.Push(dir);
            while (stack.Count > 0)
            {
                string cur = stack.Pop();
                try
                {
                    DirectoryInfo info = new DirectoryInfo(cur);
                    foreach (FileInfo f in info.GetFiles()) total += f.Length;
                    DirectoryInfo[] dirs = info.GetDirectories();
                    for (int i = 0; i < dirs.Length; i++) stack.Push(dirs[i].FullName);
                }
                catch { }
            }
            return total;
        }

        // ===================== 卸载引擎 =====================
        // 注册表只碰 HKCU\Software\WaveForge 与卸载器自身的 GUID 键；保留模式下用户数据一个字节不动。

        private class UninstallItem
        {
            public string Key;      // 稳定 id，供前端列表
            public string Label;    // 展示名
            public string Path;     // 目标路径/注册表键
            public string Kind;     // dir | file | regkey | regvalue
            public bool Keepable;   // 是否可勾选保留
            public bool Keep;       // 用户是否选择保留
            public bool Exists;
            public string SizeText;
            public string Detail;
            public string Base;
        }

        private System.Collections.Generic.List<UninstallItem> _unItems;

        private string UserDataDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WaveForge 澜音工坊");
        }

        private object DoScanUninstall()
        {
            _unItems = new System.Collections.Generic.List<UninstallItem>();
            string instdir = Environment.GetEnvironmentVariable("WF_INSTALLDIR");
            if (string.IsNullOrEmpty(instdir)) instdir = Bs("INSTALLDIR", null) ?? Bs("DIR_CURRENT", "");
            string userData = UserDataDir();
            string localCache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WaveForge");
            string updaterDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "waveforge-updater");
            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs", "WaveForge 澜音工坊");

            AddItem("dir:install", "程序文件", instdir, "dir", false, "");
            AddItem("dir:cache", "音频分析与响度缓存", localCache, "dir", false, "wf-un-detail-cache");
            AddItem("dir:updater", "历史版本更新下载缓存", updaterDir, "dir", false, "");
            AddItem("dir:startmenu", "开始菜单快捷方式", startMenu, "dir", false, "");
            AddItem("ud:cache", "网页缓存与本地数据库", userData, "udcache", false, "wf-un-detail-udcache");
            AddItem("ud:logs", "运行日志", Path.Combine(userData, "automix-backend.log"), "file", false, "");

            if (Directory.Exists(userData))
            {
                string[] settingsFiles = {
                    "config.json", "performance-settings.json", "shortcut-settings.json",
                    "desktop-player-settings.json", "desktop-lyrics-settings.json",
                    "taskbar-widget-settings.json", "window-state.json", "remote-settings.json",
                    "device-license.json",
                };
                AddItem("ud:settings", "个性化配置", string.Join("|", settingsFiles.Select(f => Path.Combine(userData, f))), "filegroup", true, "wf-un-detail-settings");
                AddItem("ud:creds", "登录凭据", string.Join("|", new[] { "qq-cookie.txt", "soda-qr-login.json", "secure-credentials.json", "apple-web-cookies.json", "apple-bridge-profile" }.Select(f => Path.Combine(userData, f))), "filegroup", true, "wf-un-detail-creds");
                for (int i = _unItems.Count - 1; i >= 0; i -= 1)
                {
                    if (_unItems[i].Key == "ud:settings") { _unItems[i].Base = userData; break; }
                }
            }
            // 设备识别码项 = 注册表整键（DeviceId/DeviceFingerprint/旧 RedeemedCodes）
            // + userData 里的指纹快照文件。识别码本身由硬件因子派生，删干净后重装仍得到同一个 ID，
            // 之前兑换的码依旧可用；此项只决定是否残留本机识别数据。
            string fingerprintSnapshot = Path.Combine(userData, "device-fingerprint.json");
            AddItem("reg:waveforge", "设备识别码",
                "HKCU\\Software\\WaveForge" + (File.Exists(fingerprintSnapshot) ? "|" + fingerprintSnapshot : ""),
                "regkey+file", true, "识别码绑定本机硬件，删除或保留重装后不变");
            string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "WaveForge 澜音工坊.lnk");
            AddItem("lnk:desktop", "桌面快捷方式", desktopLink, "file", false, "");

            return new
            {
                installDir = instdir,
                items = _unItems.Select(i => new
                {
                    key = i.Key, label = i.Label, detail = i.Detail, keepable = i.Keepable, exists = i.Exists, size = i.SizeText, baseDir = i.Base,
                }).ToArray(),
            };
        }

        private void AddItem(string key, string label, string path, string kind, bool keepable, string detail)
        {
            bool exists = CheckExists(path, kind);
            _unItems.Add(new UninstallItem
            {
                Key = key, Label = label, Path = path, Kind = kind,
                Keepable = keepable, Keep = keepable, Exists = exists,
                SizeText = kind == "dir" ? DirSizeText(path) : "",
                Detail = detail, Base = "",
            });
        }

        private bool CheckExists(string path, string kind)
        {
            try
            {
                if (kind == "regkey") return Microsoft.Win32.Registry.CurrentUser.OpenSubKey(path.Replace("HKCU\\", "")) != null;
                if (kind == "regkey+file") return path.Split('|').Any(p =>
                    p.StartsWith("HKCU\\", StringComparison.OrdinalIgnoreCase)
                        ? Microsoft.Win32.Registry.CurrentUser.OpenSubKey(p.Substring(5)) != null
                        : File.Exists(p));
                if (kind == "filegroup") return path.Split('|').Any(p => File.Exists(p));
                if (kind == "udcache")
                {
                    string[] cacheDirs = { "Cache", "Code Cache", "GPUCache", "IndexedDB", "Local Storage", "Session Storage", "Network", "Partitions", "blob_storage", "cache", "shared_proto_db", "Shared Dictionary", "WebStorage", "SharedStorage" };
                    return cacheDirs.Any(d => Directory.Exists(Path.Combine(path, d)));
                }
                if (kind == "dir") return Directory.Exists(path);
                return File.Exists(path);
            }
            catch { return false; }
        }

        private string DirSizeText(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return "";
                long b = DirSize(dir);
                if (b <= 0) return "";
                double mb = b / 1048576.0;
                return mb >= 1024 ? (mb / 1024).ToString("F1") + " GB" : Math.Round(mb) + " MB";
            }
            catch { return ""; }
        }

        /// <summary>执行卸载：keepKeys 为要保留的项。返回删除日志（前端逐条显示）。</summary>
        private object DoRunUninstall(Dictionary<string, object> a)
        {
            // 预览模式：绝不真删，模拟逐条完成
            if (_preview)
            {
                var fake = new System.Collections.Generic.List<object>();
                string[] keys = { "dir:updater", "ud:logs", "dir:startmenu", "ud:cache", "lnk:desktop", "dir:cache", "dir:install" };
                foreach (string k in keys) fake.Add(new { key = k, ok = true });
                return new { logs = fake };
            }
            object keepObj; a.TryGetValue("keep", out keepObj);
            System.Collections.Generic.List<string> keepList = new System.Collections.Generic.List<string>();
            System.Collections.IEnumerable keepEnum = keepObj as System.Collections.IEnumerable;
            if (keepEnum != null)
            {
                foreach (object k in keepEnum) keepList.Add(k.ToString());
            }
            string[] keep = keepList.ToArray();
            var logs = new System.Collections.Generic.List<object>();
            Action<string, string, bool> log = (key, label, ok) => logs.Add(new { key = key, label = label, ok = ok });

            foreach (UninstallItem item in _unItems)
            {
                bool keepThis = keep.Contains(item.Key);
                if (!item.Exists || keepThis) { log(item.Key, item.Label, true); continue; }
                try
                {
                    switch (item.Kind)
                    {
                        case "dir": SafeDeleteDir(item.Path); break;
                        case "file": if (File.Exists(item.Path)) File.Delete(item.Path); break;
                        case "filegroup":
                            foreach (string p in item.Path.Split('|')) { try { if (File.Exists(p)) File.Delete(p); } catch { } }
                            break;
                        case "udcache":
                            foreach (string d in new[] { "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "IndexedDB", "Local Storage", "Session Storage", "Network", "Partitions", "blob_storage", "cache", "shared_proto_db", "Shared Dictionary", "SharedStorage", "WebStorage", "VideoDecodeStats", "DIPS", "component_crx_cache", "WidevineCdm" })
                            {
                                string p = Path.Combine(item.Path, d);
                                if (Directory.Exists(p)) SafeDeleteDir(p);
                                else if (File.Exists(p)) { try { File.Delete(p); } catch { } }
                            }
                            break;
                        case "regkey":
                            string sub = item.Path.Replace("HKCU\\", "");
                            Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(sub, false);
                            break;
                        case "regkey+file":
                            foreach (string p in item.Path.Split('|'))
                            {
                                if (p.StartsWith("HKCU\\", StringComparison.OrdinalIgnoreCase))
                                {
                                    Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(p.Substring(5), false);
                                }
                                else if (File.Exists(p))
                                {
                                    File.Delete(p);
                                }
                            }
                            break;
                    }
                    log(item.Key, item.Label, true);
                }
                catch (Exception ex)
                {
                    Log("uninstall fail " + item.Key + ": " + ex.Message);
                    log(item.Key, item.Label, false);
                }
            }

            // 桌面快捷方式：只在 lnk 指向安装目录时删除（绝不误删同名文件）
            try
            {
                string instdir = Bs("INSTALLDIR", null) ?? Bs("DIR_CURRENT", "");
                string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "WaveForge 澜音工坊.lnk");
                if (File.Exists(desktopLink) && LnkTargetsIn(instdir, desktopLink)) { File.Delete(desktopLink); }
            }
            catch { }

            // 卸载器自身与 NSIS 注册表由 NSIS 段负责；若纯壳调试模式（无 NSIS 父进程），这里清 shell 副本
            return new { logs = logs, };
        }

        /// <summary>删除目录：仅允许删除确认为我们软件的目录（防止误删）。</summary>
        private void SafeDeleteDir(string dir)
        {
            if (string.IsNullOrWhiteSpace(dir)) return;
            string full = Path.GetFullPath(dir).TrimEnd('\\');
            // 安装目录：必须包含我们的主程序 exe 才肯删
            if (File.Exists(Path.Combine(full, Bs("APP_EXE", "WaveForge.exe")))) { Directory.Delete(full, true); return; }
            // 其他目录：必须位于用户级 AppData 且路径名包含 WaveForge 才肯删
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            bool underUserTree = full.StartsWith(appData, StringComparison.OrdinalIgnoreCase) || full.StartsWith(localAppData, StringComparison.OrdinalIgnoreCase);
            if (underUserTree && full.IndexOf("waveforge", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                // 逐子项删除（目录在用时跳过该项），尽力而为
                foreach (string sub in Directory.EnumerateDirectories(full))
                { try { Directory.Delete(sub, true); } catch { } }
                foreach (string f in Directory.EnumerateFiles(full))
                { try { File.Delete(f); } catch { } }
                try { Directory.Delete(full, true); } catch { }
                return;
            }
            throw new InvalidOperationException("拒绝删除非本软件路径：" + full);
        }

        /// <summary>结束正在运行的 WaveForge 主程序（按主程序 exe 精确匹配进程名，不误杀）。</summary>
        private object DoKillApp()
        {
            if (_preview) return true;
            int killed = 0;
            string exeName = Path.GetFileNameWithoutExtension(Bs("APP_EXE", "WaveForge.exe"));
            foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName(exeName))
            {
                try { p.Kill(); p.WaitForExit(3000); killed += 1; } catch { }
            }
            Log("killApp: killed " + killed + " process(es) of " + exeName);
            return true;
        }

        /// <summary>lnk 目标是否指向给定目录（用 WScript.Shell COM 读取）。</summary>
        private bool LnkTargetsIn(string dir, string lnkPath)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) return false;
                dynamic shell = Activator.CreateInstance(t);
                dynamic link = shell.CreateShortcut(lnkPath);
                string target = (link.TargetPath as string ?? "");
                if (string.IsNullOrEmpty(dir)) return false;
                return target.StartsWith(Path.GetFullPath(dir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private sealed class ProcessEx
        {
            public readonly System.Diagnostics.Process Process;
            public ProcessEx(System.Diagnostics.Process p) { Process = p; }
        }
    }

    internal static class Native
    {
        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetProcessDpiAwarenessContext(IntPtr hwnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        public static uint GetDpiForWindowSafe(IntPtr hwnd)
        {
            try
            {
                uint dpi = GetDpiForWindow(hwnd);
                if (dpi >= 96 && dpi <= 480) return dpi;
            }
            catch { }
            return 96;
        }

        // WebView2 Evergreen 版本：官方注册表位置（HKLM 64/32 位 + HKCU 兜底）
        public static string GetWebView2Version()
        {
            string[] keys = {
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                @"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            };
            Microsoft.Win32.RegistryKey[] roots = new Microsoft.Win32.RegistryKey[] {
                Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64),
                Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry32),
                Microsoft.Win32.Registry.CurrentUser,
            };
            foreach (Microsoft.Win32.RegistryKey root in roots)
            {
                foreach (string k in keys)
                {
                    try
                    {
                        using (Microsoft.Win32.RegistryKey rk = root.OpenSubKey(k))
                        {
                            if (rk != null)
                            {
                                string pv = (rk.GetValue("pv") as string) ?? "";
                                if (!string.IsNullOrEmpty(pv) && pv != "0.0.0.0") return pv;
                            }
                        }
                    }
                    catch { }
                }
            }
            return "";
        }

        public static string GetDpiAwareness()
        {
            try
            {
                IntPtr ctx = GetProcessDpiAwarenessContext(IntPtr.Zero);
                if (ctx == new IntPtr(-4)) return "PMv2";
                if (ctx == new IntPtr(-3)) return "System";
                if (ctx == new IntPtr(-2)) return "PerMonitor";
                if (ctx == new IntPtr(-1)) return "Unaware";
            }
            catch { }
            return "unknown";
        }

        public static void RoundCorners(IntPtr hwnd)
        {
            try
            {
                int preference = 2; // DWMWCP_ROUND
                DwmSetWindowAttribute(hwnd, 33, ref preference, 4); // DWMWA_WINDOW_CORNER_PREFERENCE
            }
            catch { }
        }
    }
}
