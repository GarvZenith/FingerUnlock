using System.Net;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

// FingerUnlock push service.
// Runs two ways from the same exe:
//   * Windows Service (LocalSystem, auto-start, launched with "--service") — it
//     is alive at the cold-boot logon screen, before anyone logs in. Lock /
//     logon / logoff are detected via WTS session notifications (OnSessionChange),
//     which is the only mechanism that works in session 0.
//   * Console app (dev/test: `dotnet run`) — unchanged from before: lock is
//     detected via SystemEvents.SessionSwitch.
// On lock (or at cold boot) it pushes the phone a Yes/No notification; on approval
// (or a direct /unlock) it writes unlock.flag, which the credential provider uses
// to UNLOCK (post-login) or LOG IN (cold boot) with the account in config.ini.

static class Program
{
    const string Dir        = @"C:\FingerUnlock";
    const string FlagPath   = Dir + @"\unlock.flag";
    const string ConfigPath = Dir + @"\service.ini";
    const string LogPath    = Dir + @"\service.log";
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
    static string _pushToken = "";

    static void Main(string[] args)
    {
        if (args.Length > 0 && args[0].Equals("--service", StringComparison.OrdinalIgnoreCase))
        {
            _service = true;
            ServiceBase.Run(new FuService());   // blocks until the SCM stops us
            return;
        }
        RunConsole();
    }

    // ---- console / dev mode (unchanged detection: SessionSwitch) --------------
    static void RunConsole()
    {
        LoadConfig();
        Crypto.Load();
        SystemEvents.SessionSwitch += (_, e) =>
        {
            if (e.Reason == SessionSwitchReason.SessionLock)        OnLocked(false);
            else if (e.Reason == SessionSwitchReason.SessionUnlock) OnUnlocked();
        };
        if (!StartHttp()) return;
        Log($"Console mode on :{_port}. Phone token {(_pushToken.Length > 0 ? "SET" : "NOT set")}. Waiting for lock...");
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
            StartHttp();
            // At boot we sit at the logon screen with no interactive user -> treat
            // as locked and ring the phone ONCE (retry while the network comes up).
            bool atLogon = CurrentConsoleUser().Length == 0;
            Log($"Service started on :{_port}. atLogon={atLogon}. Phone token {(_pushToken.Length > 0 ? "SET" : "NOT set")}.");
            if (atLogon) OnLocked(retry: true);
            else _locked = false;
        }
        protected override void OnStop() => Log("Service stopping.");
        // Powering off / restarting: never ring the phone during teardown.
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
                case SessionChangeReason.SessionLogoff:  _locked = true;  break;  // back at logon screen, but DON'T push (this also fires on restart/shutdown)
            }
        }
    }

    // ---- shared lock/unlock logic --------------------------------------------
    // Sends exactly ONE unlock push per lock. Idempotent: if we're already locked
    // with a push pending, extra lock events (which Windows fires a couple of times
    // around the logon screen at boot) do NOT create duplicate notifications.
    // retry=true -> keep trying every 2s while the network/Tailscale comes up (cold boot).
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

    // Returns true on a 2xx from Expo.
    static bool SendPush(bool unlock, string nonce)
    {
        if (_pushToken.Length == 0) { Log("No phone push token (pushtoken= in service.ini)."); return false; }
        object msg = unlock
            ? new {
                to = _pushToken,
                title = $"Unlock {Environment.MachineName}?",
                body = "Approve with your fingerprint",
                priority = "high", sound = "default", categoryId = "unlock", channelId = "unlock",
                data = new { type = "unlock", nonce, machine = Environment.MachineName }
              }
            : new { to = _pushToken, priority = "high", data = new { type = "cancel" } };
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
                if (pt.Length > 0) { _pushToken = pt; SavePushToken(pt); code = 200; reply = "REGISTERED"; Log($"Paired phone push token from {remote}."); }
            }
            else if (req.HttpMethod == "POST" && path == "/info")   // auto-detect PC name + lock state
            {
                if (Field(body, "token") == _token)
                { code = 200; reply = JsonSerializer.Serialize(new { machine = Environment.MachineName, user = DisplayUser(), locked = _locked, paired = Crypto.Ready }); }
            }
            else if (req.HttpMethod == "POST" && path == "/pair2")   // exchange ECDH public keys (Stage 2)
            {
                if (Field(body, "token") == _token)
                {
                    string pub = Field(body, "phonePub");
                    if (pub.Length > 0) { Crypto.SetPhonePub(pub); Log($"ECDH paired with phone from {remote}."); }
                    code = 200; reply = JsonSerializer.Serialize(new { pcPub = Crypto.PublicKeyHex() });
                }
            }
            else if (req.HttpMethod == "POST" && path == "/approve")
            {
                string tok = Field(body, "token"), nonce = Field(body, "nonce");
                bool ok; lock (Gate) ok = tok == _token && nonce.Length > 0 && nonce == _pendingNonce;
                if (ok)
                {
                    // Stage 2: if the phone sent an encrypted password blob, decrypt it and
                    // hand it to the credential provider (cred.bin). Otherwise fall back to
                    // the old flag-only path (CP uses config.ini) so nothing breaks.
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
                else Log($"approve DENIED from {remote} (token/nonce mismatch).");
            }
            else if (req.HttpMethod == "POST" && path == "/deny")
            {
                lock (Gate) _pendingNonce = null;
                code = 200; reply = "OK"; Log($"User DENIED from {remote}.");
            }
            else if (req.HttpMethod == "POST" && path == "/unlock")   // manual / card-tap (token only)
            {
                if (Field(body, "token") == _token || req.Headers["X-Token"] == _token)
                { File.WriteAllText(FlagPath, "unlock"); code = 200; reply = "OK"; Log($"Manual unlock from {remote}."); }
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

    // Display name for /info: the interactive console user. Empty at the cold-boot
    // logon screen (no one logged in yet); in console/dev mode fall back to the
    // process user so the card still shows a name.
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
            else if (l.StartsWith("token="))     _token = l[6..].Trim();
            else if (l.StartsWith("pushtoken=")) _pushToken = l[10..].Trim();
        }
    }

    static void SavePushToken(string pt)
    {
        try
        {
            var lines = File.Exists(ConfigPath) ? new List<string>(File.ReadAllLines(ConfigPath)) : new();
            int i = lines.FindIndex(x => x.TrimStart().StartsWith("pushtoken="));
            if (i >= 0) lines[i] = "pushtoken=" + pt; else lines.Add("pushtoken=" + pt);
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

    // ---- WTS: who is logged into the physical console session ----------------
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
