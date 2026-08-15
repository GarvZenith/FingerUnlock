using System.Security.Cryptography;
using System.Text;

// Stage 2 — phone-vault ECDH. The PC holds a static P-256 keypair (private key
// DPAPI-protected at rest) and the phone's public key. The account password is
// NEVER stored here; the phone sends it encrypted on each approval, we decrypt it
// in RAM and hand it to the credential provider via a short-lived DPAPI cred.bin.
//
// Interop with the app's @noble crypto:
//   - public keys are raw uncompressed points 0x04||X||Y (hex)
//   - shared secret = ECDH X coordinate (32 bytes)
//   - key = HKDF-SHA256(sharedX, salt = nonce-utf8, info = "FingerUnlock-v1", 32)
//   - AES-256-GCM, 12-byte iv, aad = nonce-utf8, blob = ciphertext || 16-byte tag
static class Crypto
{
    const string Dir      = @"C:\FingerUnlock";
    const string KeysPath = Dir + @"\keys.ini";
    const string CredPath = Dir + @"\cred.bin";
    static readonly byte[] Info = Encoding.UTF8.GetBytes("FingerUnlock-v1");

    static ECDiffieHellman? _pc;   // PC static keypair
    static byte[]? _phonePub;      // phone static public key (0x04||X||Y)

    public static bool Ready => _pc != null && _phonePub != null;

    // Load the PC keypair (create + persist on first run) and any stored phone key.
    public static void Load()
    {
        try
        {
            string? pcHex = null, phoneHex = null;
            if (File.Exists(KeysPath))
                foreach (var raw in File.ReadAllLines(KeysPath))
                {
                    var l = raw.Trim();
                    if (l.StartsWith("pcpriv="))        pcHex    = l[7..].Trim();
                    else if (l.StartsWith("phonepub=")) phoneHex = l[9..].Trim();
                }

            _pc = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
            bool haveKey = false;
            if (!string.IsNullOrEmpty(pcHex))
                try
                {
                    var pkcs8 = ProtectedData.Unprotect(Convert.FromHexString(pcHex), null, DataProtectionScope.LocalMachine);
                    _pc.ImportPkcs8PrivateKey(pkcs8, out _);
                    Array.Clear(pkcs8);
                    haveKey = true;
                }
                catch { /* corrupt -> regenerate */ }

            if (!haveKey)
            {
                var pkcs8 = _pc.ExportPkcs8PrivateKey();
                var prot  = ProtectedData.Protect(pkcs8, null, DataProtectionScope.LocalMachine);
                Array.Clear(pkcs8);
                Save("pcpriv", Convert.ToHexString(prot));
            }

            if (!string.IsNullOrEmpty(phoneHex)) _phonePub = Convert.FromHexString(phoneHex);
        }
        catch (Exception ex) { Console.WriteLine("crypto load: " + ex.Message); }
    }

    // Our public key (0x04||X||Y hex) for the app to pin at pairing.
    public static string PublicKeyHex()
    {
        var p = _pc!.PublicKey.ExportParameters();
        var buf = new byte[65];
        buf[0] = 0x04;
        Array.Copy(p.Q.X!, 0, buf, 1, 32);
        Array.Copy(p.Q.Y!, 0, buf, 33, 32);
        return Convert.ToHexString(buf);
    }

    public static void SetPhonePub(string phonePubHex)
    {
        _phonePub = Convert.FromHexString(phonePubHex);
        Save("phonepub", phonePubHex.ToUpperInvariant());
    }

    // Decrypt the password the phone sent. Returns null on any failure (caller
    // then falls back to the config.ini path).
    public static string? DecryptPassword(string nonce, string ivHex, string ctHex)
    {
        if (_pc == null || _phonePub == null) return null;
        byte[]? key = null, sharedX = null, pt = null;
        try
        {
            using var phone = ECDiffieHellman.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = _phonePub[1..33], Y = _phonePub[33..65] }
            });
            sharedX = _pc.DeriveRawSecretAgreement(phone.PublicKey);
            byte[] nonceB = Encoding.UTF8.GetBytes(nonce);
            key = HKDF.DeriveKey(HashAlgorithmName.SHA256, sharedX, 32, nonceB, Info);

            byte[] iv   = Convert.FromHexString(ivHex);
            byte[] blob = Convert.FromHexString(ctHex);
            int tagLen  = 16, ctLen = blob.Length - tagLen;
            if (ctLen < 0) return null;
            pt = new byte[ctLen];
            using (var gcm = new AesGcm(key, tagLen))
                gcm.Decrypt(iv, blob.AsSpan(0, ctLen), blob.AsSpan(ctLen, tagLen), pt, nonceB);
            return Encoding.UTF8.GetString(pt);
        }
        catch { return null; }
        finally
        {
            if (key != null)     Array.Clear(key);
            if (sharedX != null) Array.Clear(sharedX);
            if (pt != null)      Array.Clear(pt);
        }
    }

    // Hand the password to the credential provider: DPAPI(LocalMachine) so only
    // SYSTEM on this machine can read it, and only until the CP consumes+deletes it.
    public static void WriteCred(string password)
    {
        var bytes = Encoding.Unicode.GetBytes(password);   // UTF-16LE for the C++ CP
        try
        {
            var prot = ProtectedData.Protect(bytes, null, DataProtectionScope.LocalMachine);
            File.WriteAllBytes(CredPath, prot);
        }
        finally { Array.Clear(bytes); }
    }

    static void Save(string key, string val)
    {
        var lines = File.Exists(KeysPath) ? new List<string>(File.ReadAllLines(KeysPath)) : new();
        int i = lines.FindIndex(x => x.TrimStart().StartsWith(key + "="));
        if (i >= 0) lines[i] = key + "=" + val; else lines.Add(key + "=" + val);
        File.WriteAllLines(KeysPath, lines);
    }
}
