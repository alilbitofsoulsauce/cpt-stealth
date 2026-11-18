using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class TrayForm : Form
{
    private const string AppName = "Packet Tracer Helper";
    private const string ProcessError = "The Node.js helper could not return a result. Check that Node.js 22 or newer is installed.";
    private const int MaxAttachments = 8;
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private readonly string nodePath;
    private readonly string helperPath;
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    private readonly Label accountLabel;
    private readonly Label connectionLabel;
    private readonly Button accountButton;
    private readonly Button refreshButton;
    private readonly Button setupButton;
    private readonly Button buildButton;
    private readonly Button attachButton;
    private readonly Button removeAttachmentButton;
    private readonly Button openButton;
    private readonly Button folderButton;
    private readonly TextBox prompt;
    private readonly ListBox attachments;
    private readonly TextBox result;
    private readonly ContextMenuStrip trayMenu;
    private readonly NotifyIcon tray;
    private readonly Timer bridgeTimer;
    private readonly string heartbeatPath;
    private Process activeProcess;
    private Process signInProcess;
    private int buildVersion;
    private int accountVersion;
    private bool connected;
    private bool codexConnected;
    private bool exiting;
    private bool resourcesDisposed;
    private string outputPath;
    private string labsPath;

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string helper = args.Length == 0 ? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "helper.mjs") : args[0];
        if (args.Length > 1 || !Path.IsPathRooted(helper) || !File.Exists(helper))
        {
            MessageBox.Show("Extract the entire Windows ZIP before opening the helper.", AppName);
            return 1;
        }

        string node = FindNode(Path.GetDirectoryName(helper));
        if (node == null)
        {
            MessageBox.Show("Install Node.js 22 or newer, then start Packet Tracer Helper again.", AppName);
            return 1;
        }

        using (var form = new TrayForm(node, helper)) Application.Run(form);
        return 0;
    }

    private static string FindNode(string appDirectory)
    {
        string bundled = Path.Combine(appDirectory, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string searchPath = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
        foreach (string entry in searchPath.Split(Path.PathSeparator))
        {
            string directory = Environment.ExpandEnvironmentVariables(entry.Trim().Trim('"'));
            try
            {
                if (!Path.IsPathRooted(directory)) continue;
                string candidate = Path.Combine(directory, "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { }
        }

        const string discovery = "Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' -ErrorAction SilentlyContinue | " +
            "Sort-Object Version -Descending | ForEach-Object { Join-Path $_.InstallLocation 'dependencies\\node\\bin\\node.exe' } | " +
            "Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1";
        try
        {
            var settings = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -Command \"" + discovery + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            };
            using (Process process = Process.Start(settings))
            {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                if (!process.WaitForExit(10000))
                {
                    process.Kill();
                    return null;
                }
                string candidate = output.GetAwaiter().GetResult().Trim();
                return File.Exists(candidate) ? candidate : null;
            }
        }
        catch (System.ComponentModel.Win32Exception) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private TrayForm(string nodePath, string helperPath)
    {
        this.nodePath = nodePath;
        this.helperPath = helperPath;
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PacketTracerHelper");
        labsPath = Path.Combine(profile, "labs");
        heartbeatPath = Path.Combine(profile, "bridge", "ready.json");
        bridgeTimer = new Timer { Interval = 2500 };
        bridgeTimer.Tick += (sender, e) => UpdateBridgeStatus();
        Text = AppName;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        Font = new Font("Segoe UI", 10);
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(570, 417);
        BackColor = Color.FromArgb(245, 247, 250);
        ForeColor = Color.FromArgb(25, 39, 55);
        Icon = SystemIcons.Application;

        accountLabel = AddLabel("Checking ChatGPT sign-in...", 22, 22, 343, 22);
        accountButton = AddButton("Continue with ChatGPT", 375, 15, 173, 33);
        connectionLabel = AddLabel("Checking Packet Tracer...", 22, 61, 316, 24);
        refreshButton = AddButton("Refresh", 344, 54, 78, 33);
        setupButton = AddButton("Set up module", 430, 54, 118, 33);
        AddLabel("Describe your network", 22, 98, 526, 24);
        prompt = new TextBox
        {
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            MaxLength = 4000,
            AccessibleName = "Describe your network",
            Bounds = new Rectangle(22, 124, 526, 75)
        };
        Controls.Add(prompt);
        AddLabel("Reference files", 22, 206, 300, 24);
        attachments = new ListBox
        {
            AccessibleName = "Attached PDF and image files",
            DisplayMember = "Name",
            IntegralHeight = false,
            HorizontalScrollbar = true,
            SelectionMode = SelectionMode.MultiExtended,
            Bounds = new Rectangle(22, 232, 400, 51)
        };
        Controls.Add(attachments);
        attachButton = AddButton("Attach files...", 430, 231, 118, 25);
        removeAttachmentButton = AddButton("Remove", 430, 258, 118, 25);
        removeAttachmentButton.Enabled = false;
        Button exampleButton = AddButton("Use example", 22, 293, 106, 35);
        buildButton = AddButton("Build", 411, 293, 137, 35);
        buildButton.FlatStyle = FlatStyle.Flat;
        buildButton.FlatAppearance.BorderSize = 0;
        buildButton.BackColor = Color.FromArgb(18, 80, 140);
        buildButton.ForeColor = Color.White;
        result = new TextBox
        {
            AccessibleName = "Build and account status",
            ReadOnly = true,
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = BackColor,
            ForeColor = ForeColor,
            BorderStyle = BorderStyle.None,
            Bounds = new Rectangle(22, 338, 526, 35)
        };
        Controls.Add(result);
        openButton = AddButton("Open lab", 22, 377, 95, 30);
        folderButton = AddButton("Open labs folder", 123, 377, 136, 30);
        openButton.Visible = false;
        folderButton.Visible = false;

        trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Open Packet Tracer Helper", null, (sender, e) => ShowHelper());
        trayMenu.Items.Add("Exit", null, (sender, e) => { exiting = true; Close(); });
        tray = new NotifyIcon { Icon = Icon, Text = AppName, ContextMenuStrip = trayMenu, Visible = true };
        tray.DoubleClick += (sender, e) => ShowHelper();

        accountButton.Click += async (sender, e) =>
        {
            if (connected) await RunCommand("sign-out");
            else await SignIn();
        };
        refreshButton.Click += async (sender, e) => await RunCommand("status");
        setupButton.Click += async (sender, e) => await RunCommand("prepare");
        attachButton.Click += (sender, e) => AttachFiles();
        removeAttachmentButton.Click += (sender, e) =>
        {
            foreach (FileInfo item in attachments.SelectedItems.Cast<FileInfo>().ToArray()) attachments.Items.Remove(item);
        };
        attachments.SelectedIndexChanged += (sender, e) => UpdateAttachmentButtons();
        exampleButton.Click += (sender, e) =>
        {
            prompt.Text = "Connect two PCs through a switch on 192.168.10.0/24. Give them addresses .10 and .11 and check they can ping each other.";
            prompt.Focus();
        };
        buildButton.Click += async (sender, e) => await Build();
        openButton.Click += (sender, e) => OpenPath(outputPath, "The saved lab could not be opened.");
        folderButton.Click += (sender, e) => OpenPath(labsPath, "The labs folder could not be opened.");
        Shown += async (sender, e) => { await RunCommand("status"); if (!exiting) bridgeTimer.Start(); };
        FormClosing += (sender, e) =>
        {
            if (!exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
            else exiting = true;
        };
    }

    private Label AddLabel(string text, int x, int y, int width, int height)
    {
        var label = new Label { Text = text, Bounds = new Rectangle(x, y, width, height) };
        Controls.Add(label);
        return label;
    }

    private Button AddButton(string text, int x, int y, int width, int height)
    {
        var button = new Button { Text = text, Bounds = new Rectangle(x, y, width, height) };
        Controls.Add(button);
        return button;
    }

    private void ShowHelper()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void SetBusy(bool busy)
    {
        UpdateAccountButton();
        refreshButton.Enabled = !busy;
        setupButton.Enabled = !busy;
        buildButton.Enabled = !busy;
        UpdateAttachmentButtons();
    }

    private void UpdateAttachmentButtons()
    {
        attachButton.Enabled = activeProcess == null;
        removeAttachmentButton.Enabled = activeProcess == null && attachments.SelectedItems.Count > 0;
    }

    private void AttachFiles()
    {
        using (var dialog = new OpenFileDialog())
        {
            dialog.Title = "Attach topology references";
            dialog.Filter = "PDF and image files (*.pdf;*.png;*.jpg;*.jpeg;*.webp)|*.pdf;*.png;*.jpg;*.jpeg;*.webp";
            dialog.CheckFileExists = true;
            dialog.Multiselect = true;
            if (dialog.ShowDialog(this) != DialogResult.OK) return;

            var existing = new HashSet<string>(attachments.Items.Cast<FileInfo>().Select(item => item.FullName), StringComparer.OrdinalIgnoreCase);
            var selected = dialog.FileNames.Select(path => new FileInfo(path)).Where(item => existing.Add(item.FullName)).ToArray();
            if (existing.Count > MaxAttachments)
            {
                result.Text = "Choose up to 8 reference files per build.";
                return;
            }
            attachments.Items.AddRange(selected);
        }
    }

    private void UpdateAccountButton()
    {
        accountButton.Enabled = activeProcess == null && signInProcess == null;
        if (signInProcess != null) accountButton.Text = "Waiting for browser...";
        else accountButton.Text = connected ? "Sign out" : "Continue with ChatGPT";
    }

    private void UpdateAccountLabel()
    {
        if (connected) accountLabel.Text = "Using your ChatGPT plan";
        else if (codexConnected) accountLabel.Text = "Using your existing Codex sign-in";
        else accountLabel.Text = "ChatGPT is signed out";
    }

    private void UpdateBridgeStatus()
    {
        bool ready = DateTime.UtcNow - File.GetLastWriteTimeUtc(heartbeatPath) < TimeSpan.FromSeconds(10);
        connectionLabel.Text = ready ? "Packet Tracer is ready" : "Waiting for Packet Tracer";
    }

    private async Task Build()
    {
        buildVersion++;
        if (!connected && !codexConnected)
        {
            result.Text = "Connect your ChatGPT account first.";
            return;
        }
        if (String.IsNullOrWhiteSpace(prompt.Text) && attachments.Items.Count == 0)
        {
            prompt.Focus();
            result.Text = "Describe your network or attach a PDF or image.";
            return;
        }

        outputPath = null;
        openButton.Visible = false;
        result.Text = "Planning and building your lab...";
        string command = connected ? "build" : "build-codex";
        if (attachments.Items.Count == 0)
        {
            await RunCommand(command, prompt.Text);
        }
        else
        {
            var request = new { prompt = prompt.Text, attachments = attachments.Items.Cast<FileInfo>().Select(item => item.FullName).ToArray() };
            await RunCommand(command + "-request", serializer.Serialize(request));
        }
    }

    private async Task SignIn()
    {
        if (signInProcess != null || activeProcess != null || exiting) return;
        int initialBuildVersion = buildVersion;
        string message;
        using (var process = new Process())
        {
            signInProcess = process;
            UpdateAccountButton();
            try
            {
                var response = await Execute(process, "sign-in", "");
                if (exiting) return;
                if (Flag(response, "ok") && Flag(response, "connected"))
                {
                    connected = true;
                    accountVersion++;
                    UpdateAccountLabel();
                    message = "ChatGPT account connected.";
                }
                else if (Flag(response, "ok")) message = "Your account did not grant ChatGPT plan usage.";
                else message = TextValue(response, "error") ?? "The helper exited before returning a sign-in result.";
            }
            catch (Exception)
            {
                message = ProcessError;
            }
            finally
            {
                signInProcess = null;
                if (!exiting) UpdateAccountButton();
            }
        }
        if (!exiting && initialBuildVersion == buildVersion) result.Text = message;
    }

    private async Task<Dictionary<string, object>> Execute(Process process, string command, string input)
    {
        process.StartInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "\"" + helperPath + "\" " + command,
            WorkingDirectory = Path.GetDirectoryName(helperPath),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8,
            StandardErrorEncoding = Utf8
        };
        process.Start();
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        byte[] bytes = Utf8.GetBytes(input);
        using (Stream stdin = process.StandardInput.BaseStream)
        {
            if (bytes.Length > 0) await stdin.WriteAsync(bytes, 0, bytes.Length);
        }
        await Task.WhenAll(stdout, stderr, Task.Run(() => process.WaitForExit()));
        return serializer.Deserialize<Dictionary<string, object>>(stdout.Result);
    }

    private async Task RunCommand(string command, string input = "")
    {
        if (activeProcess != null || exiting) return;
        int initialAccountVersion = accountVersion;
        Dictionary<string, object> response;
        using (var process = new Process())
        {
            activeProcess = process;
            SetBusy(true);
            try
            {
                response = await Execute(process, command, input);
            }
            catch (Exception)
            {
                if (!exiting) result.Text = ProcessError;
                return;
            }
            finally
            {
                if (ReferenceEquals(activeProcess, process)) activeProcess = null;
                if (!exiting) SetBusy(false);
            }
        }

        if (exiting) return;
        if (!Flag(response, "ok"))
        {
            result.Text = TextValue(response, "error") ?? "The helper exited before returning a result.";
            return;
        }

        switch (command)
        {
            case "status":
                var account = Value(response, "account") as Dictionary<string, object>;
                if (initialAccountVersion == accountVersion) connected = Flag(account, "connected");
                codexConnected = Flag(Value(response, "codex") as Dictionary<string, object>, "connected");
                UpdateAccountButton();
                UpdateAccountLabel();
                if (!connected && !codexConnected && String.IsNullOrWhiteSpace(result.Text))
                    result.Text = TextValue(account, "error") ?? "";
                bool ready = Flag(Value(response, "bridge") as Dictionary<string, object>, "ready");
                connectionLabel.Text = ready ? "Packet Tracer is ready" : "Waiting for Packet Tracer";
                labsPath = TextValue(response, "labsPath") ?? labsPath;
                break;
            case "prepare":
                ShowSetup(TextValue(response, "modulePath"), TextValue(response, "bridgePath"));
                break;
            case "sign-out":
                result.Text = Flag(response, "revoked") ? "Signed out of the ChatGPT account linked to this helper." : "Signed out locally. Review app access in ChatGPT settings.";
                await RunCommand("status");
                break;
            case "build":
            case "build-codex":
            case "build-request":
            case "build-codex-request":
                ShowBuildResult(response);
                break;
        }
    }

    private void ShowBuildResult(Dictionary<string, object> response)
    {
        outputPath = TextValue(response, "outputPath");
        if (!File.Exists(outputPath))
        {
            result.Text = "The build did not return a saved Packet Tracer lab.";
            return;
        }
        var checks = Value(response, "checks") as ICollection;
        int checkCount = checks == null ? 0 : checks.Count;
        if (!Flag(response, "verified")) result.Text = "Saved the lab. Review the connectivity checks in Packet Tracer.";
        else if (checkCount == 1) result.Text = "Saved the lab. 1 connectivity check passed.";
        else if (checkCount > 1) result.Text = "Saved the lab. " + checkCount + " connectivity checks passed.";
        else result.Text = "Saved the lab.";
        openButton.Visible = true;
        folderButton.Visible = Directory.Exists(labsPath);
    }

    private void ShowSetup(string modulePath, string bridgePath)
    {
        using (var dialog = new Form())
        {
            dialog.Text = "Set up the Packet Tracer module";
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.ClientSize = new Size(570, 232);
            dialog.Font = Font;
            dialog.AutoScaleMode = AutoScaleMode.Font;
            var instructions = new TextBox
            {
                Dock = DockStyle.Top,
                Height = 182,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                AccessibleName = "Packet Tracer module setup instructions",
                Text = "In Packet Tracer, open Extensions > Scripting > Configure PT Script Modules and choose Add. " +
                    "Paste the module path below. If the module is stopped after adding it, select it and choose Start.\r\n\r\n" +
                    modulePath + "\r\n\r\nIf Packet Tracer asks for the connection file, use this path\r\n" + bridgePath
            };
            var copyModule = new Button { Text = "Copy module path", Bounds = new Rectangle(12, 192, 155, 30) };
            var copyConnection = new Button { Text = "Copy connection path", Bounds = new Rectangle(175, 192, 175, 30) };
            copyModule.Click += (sender, e) => Clipboard.SetText(modulePath);
            copyConnection.Click += (sender, e) => Clipboard.SetText(bridgePath);
            dialog.Controls.Add(instructions);
            dialog.Controls.Add(copyModule);
            dialog.Controls.Add(copyConnection);
            dialog.ShowDialog(this);
        }
    }

    private void OpenPath(string path, string error)
    {
        if (File.Exists(path) || Directory.Exists(path))
        {
            try
            {
                using (Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true })) { }
                return;
            }
            catch (System.ComponentModel.Win32Exception) { }
        }
        result.Text = error;
    }

    private static object Value(Dictionary<string, object> response, string key)
    {
        object value;
        return response != null && response.TryGetValue(key, out value) ? value : null;
    }

    private static string TextValue(Dictionary<string, object> response, string key)
    {
        return Value(response, key) as string;
    }

    private static bool Flag(Dictionary<string, object> response, string key)
    {
        return Object.Equals(Value(response, key), true);
    }

    private static void StopProcess(Process process)
    {
        if (process == null) return;
        try
        {
            if (!process.HasExited) process.Kill();
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { process.Dispose(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !resourcesDisposed)
        {
            resourcesDisposed = true;
            exiting = true;
            StopProcess(activeProcess);
            StopProcess(signInProcess);
            bridgeTimer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            trayMenu.Dispose();
        }
        base.Dispose(disposing);
    }
}
