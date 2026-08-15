using System.Net;
using System.Net.Sockets;
using System.Text;

// FingerUnlock service (Phase 2a).
// Listens on TCP. On a valid "UNLOCK <token>" request it writes the unlock flag,
// which the credential provider is already watching for -> the machine unlocks.
//
// SECURITY (Phase 2a is functional-only): the token travels in plaintext over
// TCP. Fine for a LAN test; Phase 2b/3 add TLS + a per-unlock ECDH challenge
// signed by the phone's fingerprint-gated key. Do NOT expose this port to the
// internet yet.

class Program
{
    const string FlagPath   = @"C:\FingerUnlock\unlock.flag";
    const string ConfigPath = @"C:\FingerUnlock\service.ini";

    static void Main()
    {
        var (port, token) = LoadConfig();
        var listener = new TcpListener(IPAddress.Any, port);
        listener.Start();
        Log($"FingerUnlock service listening on 0.0.0.0:{port}. Waiting for unlock requests...");

        while (true)
        {
            using var client = listener.AcceptTcpClient();
            HandleClient(client, token);
        }
    }

    static void HandleClient(TcpClient client, string token)
    {
        try
        {
            var remote = ((IPEndPoint)client.Client.RemoteEndPoint!).Address;
            using var stream = client.GetStream();

            var buf = new byte[256];
            int n = stream.Read(buf, 0, buf.Length);
            string msg = Encoding.UTF8.GetString(buf, 0, n).Trim();

            var parts = msg.Split(' ', 2);
            string reply;
            if (parts.Length == 2 && parts[0] == "UNLOCK" && parts[1] == token)
            {
                File.WriteAllText(FlagPath, "unlock");
                reply = "OK\n";
                Log($"ACCEPTED from {remote} -> unlock flag written.");
            }
            else
            {
                reply = "DENIED\n";
                Log($"DENIED from {remote} (bad token or bad request).");
            }

            var rb = Encoding.UTF8.GetBytes(reply);
            stream.Write(rb, 0, rb.Length);
        }
        catch (Exception ex)
        {
            Log("Error: " + ex.Message);
        }
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
