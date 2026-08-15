using System.Net;
using System.Text;

// FingerUnlock service (Phase 2b) — HTTP.
// POST /unlock with header  X-Token: <token>  -> writes the unlock flag, which
// the credential provider watches for, and the machine unlocks.
// HTTP (not raw TCP) so the Expo Go app can talk to it with a plain fetch().
//
// SECURITY (still functional-only): token in a header over plain HTTP. Fine on a
// trusted LAN for testing. Phase 3 adds HTTPS + a per-unlock ECDH challenge
// signed by the phone's fingerprint-gated key. Don't expose this to the internet yet.

class Program
{
    const string FlagPath   = @"C:\FingerUnlock\unlock.flag";
    const string ConfigPath = @"C:\FingerUnlock\service.ini";

    static void Main()
    {
        var (port, token) = LoadConfig();

        var listener = new HttpListener();
        listener.Prefixes.Add($"http://+:{port}/");   // all interfaces (needs admin OR a urlacl)
        try
        {
            listener.Start();
        }
        catch (HttpListenerException ex)
        {
            Log($"Could not bind port {port}: {ex.Message}");
            Log("Fix: run this terminal AS ADMINISTRATOR (or reserve the URL once with netsh).");
            return;
        }

        Log($"FingerUnlock HTTP service on http://0.0.0.0:{port}/  (POST /unlock, header X-Token)");
        while (true)
        {
            var ctx = listener.GetContext();
            HandleRequest(ctx, token);
        }
    }

    static void HandleRequest(HttpListenerContext ctx, string token)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        string remote = req.RemoteEndPoint?.Address.ToString() ?? "?";
        string reply; int code;

        try
        {
            string sent = req.Headers["X-Token"] ?? "";
            if (req.HttpMethod == "POST" && req.Url?.AbsolutePath == "/unlock" && sent == token)
            {
                File.WriteAllText(FlagPath, "unlock");
                reply = "OK"; code = 200;
                Log($"ACCEPTED from {remote} -> unlock flag written.");
            }
            else
            {
                reply = "DENIED"; code = 403;
                Log($"DENIED from {remote} (path={req.Url?.AbsolutePath}, method={req.HttpMethod}).");
            }
        }
        catch (Exception ex) { reply = "ERROR"; code = 500; Log("Error: " + ex.Message); }

        res.StatusCode = code;
        var buf = Encoding.UTF8.GetBytes(reply);
        res.ContentLength64 = buf.Length;
        res.OutputStream.Write(buf, 0, buf.Length);
        res.OutputStream.Close();
    }

    static (int port, string token) LoadConfig()
    {
        int port = 5599;
        string token = "changeme";
        if (File.Exists(ConfigPath))
        {
            foreach (var raw in File.ReadAllLines(ConfigPath))
            {
                var l = raw.Trim();
                if (l.StartsWith("port="))       int.TryParse(l[5..].Trim(), out port);
                else if (l.StartsWith("token=")) token = l[6..].Trim();
            }
        }
        else
        {
            Log($"WARNING: {ConfigPath} not found — using default token 'changeme'. Create it!");
        }
        return (port, token);
    }

    static void Log(string s) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {s}");
}
