using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using FirebaseAdmin;
using FirebaseAdmin.Messaging;
using Google.Apis.Auth.OAuth2;

// FingerUnlock push & relay service.
// Runs two ways from the same exe:
//   * Windows Service (LocalSystem, auto-start, launched with "--service")
//   * Console app (dev/test: `dotnet run` or `--pair-qr`)
// Features persistent outbound Relay WebSocket connection, automatic Device ID,
// idempotency caching, and HTTP server on port 5599.

static class Program
{
    const string Dir        = @"C:\FingerUnlock";
    const string FlagPath   = Dir + @"\unlock.flag";
    const string ConfigPath = Dir + @"\service.ini";
    const string LogPath    = Dir + @"\service.log";
    const string SaPath     = Dir + @"\serviceAccount.json";   // Firebase service-account key (gitignored)
    const string ExpoPush   = "https://exp.host/--/api/v2/push/send";

    static readonly HttpClient Http = new();
    static readonly object Gate = new();
    static readonly object LogGate = new();
    static string? _pendingNonce;
    static volatile bool _locked = false;       // current lock state (for /info)
    static volatile bool _shuttingDown = false; // system is powering off/restarting -> no pushes
    static bool _service = false;               // running as a Windows Service?

    static int    _port = 5599;
    static string _token = "changeme";
    static string _pushToken = "";        // Expo push token (legacy path)
    static string _fcmToken = "";         // FCM device token (native full-screen path, Step B)
    static bool   _fcmReady = false;      // Firebase Admin initialised?
    static string _deviceId = "";
    static string _relayUrl = "ws://localhost:5590";

    static void Main(string[] args)
    {
        if (args.Length > 0 && args[0].Equals("--service", StringComparison.OrdinalIgnoreCase))
        {
            _service = true;
            ServiceBase.Run(new FuService());   // blocks until the SCM stops us
            return;
        }

        if (args.Length > 0 && args[0].Equals("--pair-qr", StringComparison.OrdinalIgnoreCase))
        {
            LoadConfig();
            Crypto.Load();
            PrintPairingJson();
            return;
        }

        RunConsole();
    }

    static void PrintPairingJson()
    {
        var pairData = new
        {
            deviceId = _deviceId,
            name = Environment.MachineName,
            ip = GetLocalIpAddress(),
            port = _port,
            token = _token,
            relayUrl = _relayUrl,
            pcPub = Crypto.PublicKeyHex()
        };
        Console.WriteLine(JsonSerializer.Serialize(pairData));
    }

    static string GetLocalIpAddress()
    {
        try
        {
            using var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork, System.Net.Sockets.SocketType.Dgram, 0);
            socket.Connect("8.8.8.8", 65530);
            var endPoint = socket.LocalEndPoint as IPEndPoint;
            return endPoint?.Address.ToString() ?? "192.168.1.50";
        }
        catch { return "192.168.1.50"; }
    }

    // ---- console / dev mode (unchanged detection: SessionSwitch) --------------
    static void RunConsole()
    {
        LoadConfig();
        Crypto.Load();
        InitFirebase();
        SystemEvents.SessionSwitch += (_, e) =>
        {
            if (e.Reason == SessionSwitchReason.SessionLock)        OnLocked(false);
            else if (e.Reason == SessionSwitchReason.SessionUnlock) OnUnlocked();
        };
        if (!StartHttp()) return;
        RelayClient.Start();
        Log($"Console mode on :{_port}. Device ID {_deviceId}. Relay: {_relayUrl}. Waiting for lock...");
        Thread.Sleep(Timeout.Infinite);
    }

    // ---- Windows Service mode (boot-SYSTEM + WTS) ----------------------------
    sealed class FuService : ServiceBase
    {
        public FuService()
        {
            ServiceName = "FingerUnlockSvc";
            CanHandleSessionChangeEvent = true;
            CanStop = true;
            CanShutdown = true;
        }
        protected override void OnStart(string[] args)
        {
            LoadConfig();
            Crypto.Load();
            InitFirebase();
            StartHttp();
            RelayClient.Start();

            bool atLogon = CurrentConsoleUser().Length == 0;
            Log($"Service started on :{_port}. Device ID {_deviceId}. atLogon={atLogon}.");
            if (atLogon) OnLocked(retry: true);
            else _locked = false;
        }
        protected override void OnStop() => Log("Service stopping.");
        protected override void OnShutdown()
        {
            _shuttingDown = true;
            lock (Gate) _pendingNonce = null;   // cancel any pending push + stop the retry loop
            Log("System shutting down -> pushes suppressed.");
        }
        protected override void OnSessionChange(SessionChangeDescription c)
        {
            switch (c.Reason)
            {
                case SessionChangeReason.SessionLock:    OnLocked(false); break;
                case SessionChangeReason.SessionUnlock:
                case SessionChangeReason.SessionLogon:   OnUnlocked();    break;
                case SessionChangeReason.SessionLogoff:  _locked = true;  break;  // back at logon screen, but DON'T push
            }
        }
    }

    // ---- shared lock/unlock logic --------------------------------------------
    static void OnLocked(bool retry)
    {
        string nonce;
        lock (Gate)
        {
            if (_locked && _pendingNonce != null) return;   // already notified -> no duplicate
            _locked = true;
            nonce = _pendingNonce = Guid.NewGuid().ToString("N");
        }
        if (_shuttingDown) { Log("locked during shutdown -> no push."); return; }

        if (retry)
        {
            _ = Task.Run(() =>
            {
                for (int i = 0; i < 20; i++)   // ~40s window
                {
                    lock (Gate) { if (_pendingNonce != nonce) return; }   // unlocked / superseded
                    if (_shuttingDown) return;
                    if (SendPush(true, nonce)) { Log($"cold-boot push delivered (nonce {nonce[..8]})."); return; }
                    Thread.Sleep(2000);
                }
                Log("cold-boot push gave up (no network / no token).");
            });
        }
        else
        {
            SendPush(true, nonce);
            Log($"LOCKED -> push (nonce {nonce[..8]}).");
        }
    }

    static void OnUnlocked()
    {
        bool had; lock (Gate) { had = _pendingNonce != null; _pendingNonce = null; _locked = false; }
        if (had && !_shuttingDown) { SendPush(false, ""); Log("UNLOCKED -> cancel push."); }
    }

    static void InitFirebase()
    {
        try
        {
            if (!File.Exists(SaPath)) { Log($"FCM off: {SaPath} not found (using Expo push)."); return; }
            if (FirebaseApp.DefaultInstance == null)
                FirebaseApp.Create(new AppOptions { Credential = GoogleCredential.FromFile(SaPath) });
            _fcmReady = true;
            Log("Firebase (FCM v1) ready.");
        }
        catch (Exception ex) { Log("firebase init: " + ex.Message); }
    }

    static bool SendFcm(bool unlock, string nonce)
    {
        try
        {
            var data = unlock
                ? new Dictionary<string, string> { { "type", "unlock" }, { "nonce", nonce }, { "machine", Environment.MachineName } }
                : new Dictionary<string, string> { { "type", "cancel" } };
            var msg = new Message { Token = _fcmToken, Data = data, Android = new AndroidConfig { Priority = Priority.High } };
            FirebaseMessaging.DefaultInstance.SendAsync(msg).GetAwaiter().GetResult();
            Log($"FCM -> sent ({data["type"]})");
            return true;
        }
        catch (Exception ex) { Log("fcm: " + ex.Message); return false; }
    }

    static bool SendPush(bool unlock, string nonce)
    {
        if (_fcmReady && _fcmToken.Length > 0) return SendFcm(unlock, nonce);
        if (_pushToken.Length == 0) { Log("No phone push token (pushtoken= in service.ini)."); return false; }
        object msg = unlock
            ? new {
                to = _pushToken,
                title = $"Unlock {Environment.MachineName}?",
                body = "Approve with your fingerprint",
                priority = "high", sound = "default", categoryId = "unlock", channelId = "unlock_call_v3",
                data = new { type = "unlock", nonce, machine = Environment.MachineName }
              }
            : new { to = _pushToken, priority = "high", channelId = "unlock_call_v3", data = new { type = "cancel" } };
        try
        {
            var content = new StringContent(JsonSerializer.Serialize(msg), Encoding.UTF8, "application/json");
            var resp = Http.PostAsync(ExpoPush, content).GetAwaiter().GetResult();
            Log($"Expo push -> HTTP {(int)resp.StatusCode}");
            return resp.IsSuccessStatusCode;
        }
        catch (Exception ex) { Log("push: " + ex.Message); return false; }
    }

    // ---- HTTP ----------------------------------------------------------------
    static bool StartHttp()
    {
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://+:{_port}/");
        try { listener.Start(); }
        catch (HttpListenerException ex) { Log($"Bind failed: {ex.Message}. Needs admin / SYSTEM."); return false; }

        var t = new Thread(() =>
        {
            while (true)
            {
                try { HandleHttp(listener.GetContext()); }
                catch (Exception ex) { Log("listener: " + ex.Message); Thread.Sleep(200); }
            }
        }) { IsBackground = true };
        t.Start();
        return true;
    }

    static void HandleHttp(HttpListenerContext ctx)
    {
        var req = ctx.Request; var res = ctx.Response;
        string remote = req.RemoteEndPoint?.Address.ToString() ?? "?";
        string path = req.Url?.AbsolutePath ?? "";
        string body = "";
        if (req.HasEntityBody)
            using (var r = new StreamReader(req.InputStream, req.ContentEncoding)) body = r.ReadToEnd();

        int code = 403; string reply = "DENIED";
        try
        {
            if (req.HttpMethod == "POST" && path == "/register")
            {
                string pt = Field(body, "pushToken");
                if (pt.Length > 0) { _pushToken = pt; SaveKV("pushtoken", pt); code = 200; reply = "REGISTERED"; Log($"Paired phone push token from {remote}."); }
            }
            else if (req.HttpMethod == "POST" && path == "/registerfcm")
            {
                if (Field(body, "token") == _token)
                {
                    string ft = Field(body, "fcmToken");
                    if (ft.Length > 0) { _fcmToken = ft; SaveKV("fcmtoken", ft); Log($"Paired FCM token from {remote}."); }
                    code = 200; reply = JsonSerializer.Serialize(new { fcm = _fcmReady });
                }
            }
            else if (req.HttpMethod == "POST" && path == "/info")   // auto-detect PC name + lock state + deviceId
            {
                if (Field(body, "token") == _token)
                { code = 200; reply = JsonSerializer.Serialize(new { deviceId = _deviceId, machine = Environment.MachineName, user = DisplayUser(), locked = _locked, paired = Crypto.Ready }); }
            }
            else if (req.HttpMethod == "POST" && path == "/pair2")
            {
                if (Field(body, "token") == _token)
                {
                    string pub = Field(body, "phonePub");
                    if (pub.Length > 0) { Crypto.SetPhonePub(pub); Log($"ECDH paired with phone from {remote}."); }
                    code = 200; reply = JsonSerializer.Serialize(new { deviceId = _deviceId, pcPub = Crypto.PublicKeyHex() });
                }
            }
            else if (req.HttpMethod == "POST" && path == "/challenge")
            {
                if (Field(body, "token") == _token)
                {
                    string nonce = Guid.NewGuid().ToString("N");
                    lock (Gate) _pendingNonce = nonce;
                    code = 200; reply = JsonSerializer.Serialize(new { nonce });
                }
            }
            else if (req.HttpMethod == "POST" && path == "/approve")
            {
                string tok = Field(body, "token"), nonce = Field(body, "nonce"), reqId = Field(body, "requestId");
                bool ok; lock (Gate) ok = tok == _token && (nonce.Length > 0 && nonce == _pendingNonce || _locked || nonce.Length == 0);
                if (ok && RelayClient.IsNewRequest(reqId))
                {
                    WakeDisplay();
                    string iv = Field(body, "iv"), ct = Field(body, "ct");
                    if (iv.Length > 0 && ct.Length > 0 && Crypto.Ready)
                    {
                        string? pw = Crypto.DecryptPassword(nonce, iv, ct);
                        if (pw != null) { Crypto.WriteCred(pw); Log($"APPROVED (encrypted) from {remote} -> unlocking."); }
                        else { Log($"approve from {remote}: decrypt FAILED, using fallback."); }
                    }
                    else Log($"APPROVED from {remote} -> unlocking.");
                    File.WriteAllText(FlagPath, "unlock");
                    lock (Gate) _pendingNonce = null;
                    code = 200; reply = "OK";
                }
                else Log($"approve DENIED from {remote} (token mismatch or duplicate request).");
            }
            else if (req.HttpMethod == "POST" && path == "/deny")
            {
                lock (Gate) _pendingNonce = null;
                code = 200; reply = "OK"; Log($"User DENIED from {remote}.");
            }
            else if (req.HttpMethod == "POST" && path == "/unlock")
            {
                string reqId = Field(body, "requestId");
                if ((Field(body, "token") == _token || req.Headers["X-Token"] == _token) && RelayClient.IsNewRequest(reqId))
                {
                    WakeDisplay();
                    File.WriteAllText(FlagPath, "unlock");
                    code = 200; reply = "OK"; Log($"Manual unlock from {remote}.");
                }
            }
        }
        catch (Exception ex) { code = 500; reply = "ERROR"; Log("http: " + ex.Message); }

        res.StatusCode = code;
        var buf = Encoding.UTF8.GetBytes(reply);
        res.ContentLength64 = buf.Length;
        res.OutputStream.Write(buf, 0, buf.Length);
        res.OutputStream.Close();
    }

    static string Field(string json, string key)
    {
        try { using var d = JsonDocument.Parse(json); return d.RootElement.TryGetProperty(key, out var v) ? (v.GetString() ?? "") : ""; }
        catch { return ""; }
    }

    static string DisplayUser()
    {
        string u = CurrentConsoleUser();
        if (u.Length == 0 && !_service) u = Environment.UserName;
        return u;
    }

    static void LoadConfig()
    {
        if (!File.Exists(ConfigPath)) { Log($"WARN {ConfigPath} missing."); return; }
        foreach (var raw in File.ReadAllLines(ConfigPath))
        {
            var l = raw.Trim();
            if (l.StartsWith("port="))           int.TryParse(l[5..].Trim(), out _port);
            else if (l.StartsWith("fcmtoken="))  _fcmToken = l[9..].Trim();
            else if (l.StartsWith("token="))     _token = l[6..].Trim();
            else if (l.StartsWith("pushtoken=")) _pushToken = l[10..].Trim();
            else if (l.StartsWith("deviceid="))  _deviceId = l[9..].Trim();
            else if (l.StartsWith("relayurl="))  _relayUrl = l[9..].Trim();
        }
        if (string.IsNullOrEmpty(_deviceId))
        {
            _deviceId = "FU-LAPTOP-" + Guid.NewGuid().ToString("N")[..12].ToUpper();
            SaveKV("deviceid", _deviceId);
        }
    }

    static void SaveKV(string key, string val)
    {
        try
        {
            var lines = File.Exists(ConfigPath) ? new List<string>(File.ReadAllLines(ConfigPath)) : new();
            int i = lines.FindIndex(x => x.TrimStart().StartsWith(key + "="));
            if (i >= 0) lines[i] = key + "=" + val; else lines.Add(key + "=" + val);
            File.WriteAllLines(ConfigPath, lines);
        }
        catch (Exception ex) { Log("save: " + ex.Message); }
    }

    static void Log(string s)
    {
        string line = $"[{DateTime.Now:HH:mm:ss}] {s}";
        Console.WriteLine(line);
        try
        {
            lock (LogGate)
            {
                var fi = new FileInfo(LogPath);
                if (fi.Exists && fi.Length > 1_000_000) File.Delete(LogPath);
                File.AppendAllText(LogPath, line + Environment.NewLine);
            }
        }
        catch { /* logging must never throw */ }
    }

    // ---- Self-Hosted Relay WebSocket Client -----------------------------------
    sealed class RelayClient
    {
        private static readonly HashSet<string> _processedReqs = new();
        private static readonly object _reqLock = new();

        public static bool IsNewRequest(string reqId)
        {
            if (string.IsNullOrEmpty(reqId)) return true;
            lock (_reqLock)
            {
                if (_processedReqs.Contains(reqId)) return false;
                _processedReqs.Add(reqId);
                if (_processedReqs.Count > 300) _processedReqs.Clear();
                return true;
            }
        }

        public static void Start()
        {
            Task.Run(async () =>
            {
                var cts = new CancellationTokenSource();
                while (!cts.IsCancellationRequested)
                {
                    try
                    {
                        using var ws = new ClientWebSocket();
                        var uri = new Uri(_relayUrl.Replace("http://", "ws://").Replace("https://", "wss://") + "/laptop");
                        Log($"[Relay] Connecting to {uri}...");
                        await ws.ConnectAsync(uri, cts.Token);
                        Log($"[Relay] Connected for device {_deviceId}.");

                        // Send Registration
                        var regMsg = JsonSerializer.Serialize(new
                        {
                            type = "register",
                            deviceId = _deviceId,
                            token = _token,
                            machine = Environment.MachineName
                        });
                        var regBytes = Encoding.UTF8.GetBytes(regMsg);
                        await ws.SendAsync(new ArraySegment<byte>(regBytes), WebSocketMessageType.Text, true, cts.Token);

                        // Start Ping Heartbeat loop in background
                        _ = Task.Run(async () =>
                        {
                            while (ws.State == WebSocketState.Open && !cts.IsCancellationRequested)
                            {
                                try
                                {
                                    await Task.Delay(15000, cts.Token);
                                    if (ws.State == WebSocketState.Open)
                                    {
                                        var pingMsg = JsonSerializer.Serialize(new { type = "ping" });
                                        var pingBytes = Encoding.UTF8.GetBytes(pingMsg);
                                        await ws.SendAsync(new ArraySegment<byte>(pingBytes), WebSocketMessageType.Text, true, cts.Token);
                                    }
                                }
                                catch {}
                            }
                        });

                        // Receive loop
                        var buffer = new byte[8192];
                        while (ws.State == WebSocketState.Open && !cts.IsCancellationRequested)
                        {
                            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token);
                            if (result.MessageType == WebSocketMessageType.Close) break;

                            var text = Encoding.UTF8.GetString(buffer, 0, result.Count);
                            using var doc = JsonDocument.Parse(text);
                            var root = doc.RootElement;
                            string msgType = root.TryGetProperty("type", out var t) ? (t.GetString() ?? "") : "";

                            if (msgType == "unlock")
                            {
                                string reqTok = root.TryGetProperty("token", out var tk) ? (tk.GetString() ?? "") : "";
                                string reqId = root.TryGetProperty("requestId", out var rId) ? (rId.GetString() ?? "") : "";

                                if (reqTok == _token || string.IsNullOrEmpty(_token))
                                {
                                    if (IsNewRequest(reqId))
                                    {
                                        Log($"[Relay] Remote unlock trigger (req: {reqId[..Math.Min(8, reqId.Length)]}).");
                                        WakeDisplay();
                                        File.WriteAllText(FlagPath, "unlock");
                                    }

                                    // Send ACK back to relay
                                    var ackMsg = JsonSerializer.Serialize(new { type = "ack", requestId = reqId, deviceId = _deviceId });
                                    var ackBytes = Encoding.UTF8.GetBytes(ackMsg);
                                    await ws.SendAsync(new ArraySegment<byte>(ackBytes), WebSocketMessageType.Text, true, cts.Token);
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Log($"[Relay] Client connection error: {ex.Message}");
                    }

                    await Task.Delay(3000);
                }
            });
        }
    }

    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern uint SetThreadExecutionState(uint esFlags);
    const uint ES_CONTINUOUS = 0x80000000;
    const uint ES_DISPLAY_REQUIRED = 0x00000002;
    const uint KEYEVENTF_KEYUP = 0x0002;

    static void WakeDisplay()
    {
        try
        {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED);
            keybd_event(0x10, 0, 0, UIntPtr.Zero);
            keybd_event(0x10, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
        catch {}
    }

    enum WTS_INFO_CLASS { WTSUserName = 5 }

    [DllImport("kernel32.dll")]
    static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WTSQuerySessionInformationW(IntPtr hServer, uint sessionId, WTS_INFO_CLASS infoClass, out IntPtr ppBuffer, out uint pBytesReturned);

    [DllImport("wtsapi32.dll")]
    static extern void WTSFreeMemory(IntPtr pMemory);

    static string CurrentConsoleUser()
    {
        try
        {
            uint sid = WTSGetActiveConsoleSessionId();
            if (sid == 0xFFFFFFFF) return "";
            if (WTSQuerySessionInformationW(IntPtr.Zero, sid, WTS_INFO_CLASS.WTSUserName, out var buf, out _))
            {
                string u = Marshal.PtrToStringUni(buf) ?? "";
                WTSFreeMemory(buf);
                return u;
            }
        }
        catch { /* fall through */ }
        return "";
    }
}
