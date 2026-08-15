using System.Net;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;

// FingerUnlock push service (Phase 3).
// Detects when the workstation locks (via OpenInputDesktop) and pushes the phone
// a Yes/No notification. On Yes -> phone does fingerprint -> POST /approve with the
// nonce -> we write unlock.flag, which the credential provider auto-unlocks on.
//
// Lock detection is done here (not in the credential provider) so it fires the
// instant the session locks, regardless of the lock-screen UI state.

class Program
{
    const string Dir        = @"C:\FingerUnlock";
    const string FlagPath   = Dir + @"\unlock.flag";
    const string ConfigPath = Dir + @"\service.ini";
    const string ExpoPush   = "https://exp.host/--/api/v2/push/send";

    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] static extern bool   CloseDesktop(IntPtr hDesktop);
    const uint DESKTOP_SWITCHDESKTOP = 0x0100;

    static readonly HttpClient Http = new();
    static readonly object Gate = new();
    static string? _pendingNonce;

    static int    _port = 5599;
    static string _token = "changeme";
    static string _pushToken = "";

    static void Main()
    {
        LoadConfig();
        new Thread(LockWatchLoop) { IsBackground = true }.Start();

        var listener = new HttpListener();
        listener.Prefixes.Add($"http://+:{_port}/");
        try { listener.Start(); }
        catch (HttpListenerException ex) { Log($"Bind failed: {ex.Message}. Run this terminal AS ADMIN."); return; }

        Log($"FingerUnlock push service on :{_port}. Phone token {(_pushToken.Length > 0 ? "SET" : "NOT set")}.");
        while (true) HandleHttp(listener.GetContext());
    }

    // Poll the input desktop: when the workstation is locked, the secure desktop
    // is active and OpenInputDesktop returns NULL for our user-session process.
    static void LockWatchLoop()
    {
        bool wasLocked = false;
        while (true)
        {
            try
            {
                IntPtr h = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
                bool locked = (h == IntPtr.Zero);
                if (h != IntPtr.Zero) CloseDesktop(h);

                if (locked && !wasLocked)
                {
                    string nonce = Guid.NewGuid().ToString("N");
                    lock (Gate) _pendingNonce = nonce;
                    SendPush(unlock: true, nonce);
                    Log($"Session LOCKED -> push sent (nonce {nonce[..8]}).");
                }
                else if (!locked && wasLocked)
                {
                    bool had; lock (Gate) { had = _pendingNonce != null; _pendingNonce = null; }
                    if (had) { SendPush(unlock: false, ""); Log("Session UNLOCKED -> cancel push."); }
                }
                wasLocked = locked;
            }
            catch (Exception ex) { Log("lockwatch: " + ex.Message); }
            Thread.Sleep(1000);
        }
    }

    static void SendPush(bool unlock, string nonce)
    {
        if (_pushToken.Length == 0) { Log("No phone push token (pushtoken= in service.ini)."); return; }
        object msg = unlock
            ? new {
                to = _pushToken,
                title = $"Unlock {Environment.MachineName}?",
                body = "Approve with your fingerprint",
                priority = "high", sound = "default", categoryId = "unlock", channelId = "unlock",
                data = new { type = "unlock", nonce }
              }
            : new { to = _pushToken, priority = "high", data = new { type = "cancel" } };
        try
        {
            var content = new StringContent(JsonSerializer.Serialize(msg), Encoding.UTF8, "application/json");
            var resp = Http.PostAsync(ExpoPush, content).GetAwaiter().GetResult();
            Log($"Expo push -> HTTP {(int)resp.StatusCode}");
        }
        catch (Exception ex) { Log("push: " + ex.Message); }
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
            else if (req.HttpMethod == "POST" && path == "/approve")
            {
                string tok = Field(body, "token"), nonce = Field(body, "nonce");
                bool ok; lock (Gate) ok = tok == _token && nonce.Length > 0 && nonce == _pendingNonce;
                if (ok)
                {
                    File.WriteAllText(FlagPath, "unlock");
                    lock (Gate) _pendingNonce = null;
                    code = 200; reply = "OK"; Log($"APPROVED from {remote} -> unlocking.");
                }
                else Log($"approve DENIED from {remote} (token/nonce mismatch).");
            }
            else if (req.HttpMethod == "POST" && path == "/deny")
            {
                lock (Gate) _pendingNonce = null;
                code = 200; reply = "OK"; Log($"User DENIED from {remote}.");
            }
            else if (req.HttpMethod == "POST" && path == "/unlock")   // manual/testing (token only)
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

    static void LoadConfig()
    {
        if (!File.Exists(ConfigPath)) { Log($"WARN {ConfigPath} missing."); return; }
        foreach (var raw in File.ReadAllLines(ConfigPath))
        {
            var l = raw.Trim();
            if (l.StartsWith("port="))          int.TryParse(l[5..].Trim(), out _port);
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

    static void Log(string s) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {s}");
}
