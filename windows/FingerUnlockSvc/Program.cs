using System.Net;
using System.Text;
using System.Text.Json;

// FingerUnlock push service (Phase 3).
// When the credential provider signals the lock screen is up (locked.flag), this
// sends a push to the paired phone. The phone shows a Yes/No notification; on Yes
// it does fingerprint and POSTs /approve with the nonce; we then write unlock.flag
// (which the credential provider auto-unlocks on). closed.flag -> cancel the push.
//
// Still HTTP + shared-secret token (LAN test). Phase: HTTPS + ECDH later.

class Program
{
    const string Dir        = @"C:\FingerUnlock";
    const string FlagPath   = Dir + @"\unlock.flag";
    const string LockedPath = Dir + @"\locked.flag";
    const string ClosedPath = Dir + @"\closed.flag";
    const string ConfigPath = Dir + @"\service.ini";
    const string ExpoPush   = "https://exp.host/--/api/v2/push/send";

    static readonly HttpClient Http = new();
    static readonly object Gate = new();
    static string? _pendingNonce;

    static int    _port = 5599;
    static string _token = "changeme";
    static string _pushToken = "";

    static void Main()
    {
        LoadConfig();
        new Thread(WatchLoop) { IsBackground = true }.Start();

        var listener = new HttpListener();
        listener.Prefixes.Add($"http://+:{_port}/");
        try { listener.Start(); }
        catch (HttpListenerException ex) { Log($"Bind failed: {ex.Message}. Run this terminal AS ADMIN."); return; }

        Log($"FingerUnlock push service on :{_port}. Phone token {(_pushToken.Length > 0 ? "SET" : "NOT set")}.");
        while (true) HandleHttp(listener.GetContext());
    }

    // Watch for the credential provider's lock/close signals.
    static void WatchLoop()
    {
        while (true)
        {
            try
            {
                if (File.Exists(LockedPath))
                {
                    File.Delete(LockedPath);
                    string nonce = Guid.NewGuid().ToString("N");
                    lock (Gate) _pendingNonce = nonce;
                    SendPush(unlock: true, nonce);
                    Log($"Lock screen up -> push sent (nonce {nonce[..8]}).");
                }
                if (File.Exists(ClosedPath))
                {
                    File.Delete(ClosedPath);
                    bool had; lock (Gate) { had = _pendingNonce != null; _pendingNonce = null; }
                    if (had) { SendPush(unlock: false, ""); Log("Lock screen gone -> cancel push."); }
                }
            }
            catch (Exception ex) { Log("watch: " + ex.Message); }
            Thread.Sleep(400);
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
                priority = "high", sound = "default", categoryId = "unlock",
                channelId = "unlock",
                data = new { type = "unlock", nonce }
              }
            : new {
                to = _pushToken, priority = "high",
                data = new { type = "cancel" }
              };
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
