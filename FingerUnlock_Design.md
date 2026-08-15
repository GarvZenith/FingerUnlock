# FingerUnlock — Design & Build Plan

**Goal:** Unlock a Windows laptop remotely from an Android phone using the phone's fingerprint sensor, working over LAN *and* the internet.

**Status:** Architecture & roadmap (v1). Code to follow per phase.

---

## 1. The core constraint (read this first)

Windows does **not** let a normal background program type a password into the lock screen. The lock screen runs on a separate **secure desktop** where `SendInput`/keystroke injection from a user session is blocked by design. So a "type the password with a script" approach will not work.

The only Microsoft-sanctioned ways to programmatically unlock are:

1. **Custom Credential Provider (CP)** — a native C++ COM DLL that Windows loads *inside* the lock screen (LogonUI). It can submit stored credentials to unlock. This is the modern, supported path. ✅ **We use this.**
2. **Companion Device Framework (CDF)** — the old "unlock with a phone/wearable" API. **Deprecated by Microsoft** — do not build on it. ❌

Because a Credential Provider runs in a very restricted context (no easy networking, loaded/unloaded by LogonUI), it cannot itself hold a network server. So the design splits into **two Windows components**: a persistent **Windows Service** (does networking + crypto) and the **Credential Provider** (does the actual unlock), talking over a local named pipe.

---

## 2. System components

```
 ┌─────────────────────────────┐         ┌──────────────────────────────────────────┐
 │        ANDROID PHONE        │         │              WINDOWS LAPTOP                │
 │                             │         │                                            │
 │  Kotlin app                 │         │  ┌──────────────────────────────────────┐  │
 │   • BiometricPrompt         │  secure │  │  FingerUnlock Service (LocalSystem)  │  │
 │     (fingerprint)           │ channel │  │   • network listener (TLS)           │  │
 │   • Android Keystore key ───┼────────►│  │   • challenge/response verify        │  │
 │     (hardware-backed)       │         │  │   • credential vault (LSA/DPAPI-M)   │  │
 │   • network client          │         │  │   • signals CP via named pipe        │  │
 │                             │         │  └───────────────┬──────────────────────┘  │
 └─────────────────────────────┘         │                  │ named pipe               │
                │                         │  ┌───────────────▼──────────────────────┐  │
                │  (internet range)       │  │  Credential Provider DLL (C++/COM)   │  │
                └───── Tailscale ─────────┼─►│   • shown on lock screen (LogonUI)   │  │
                       (WireGuard mesh)   │  │   • submits stored creds → UNLOCK    │  │
                                          │  └──────────────────────────────────────┘  │
                                          └────────────────────────────────────────────┘
```

**A. Android app (Kotlin, Android Studio)**
- `BiometricPrompt` API for the fingerprint gate.
- A private key generated in the **Android Keystore** with `setUserAuthenticationRequired(true)` — the key is *only usable after a successful fingerprint*, enforced by hardware (TEE/StrongBox). This is what cryptographically ties "fingerprint happened" to "unlock request signed."
- Network client that reaches the laptop (directly on LAN, or via Tailscale for internet).

**B. Windows Service** (`FingerUnlockSvc`, runs as LocalSystem, auto-start)
- Listens for connections (TLS).
- Runs the pairing + per-unlock challenge/response.
- Stores the Windows account credential securely (see §4).
- On a verified request, signals the Credential Provider through a named pipe and (if the machine is asleep) can request wake.

**C. Credential Provider DLL** (`FingerUnlockCP`, C++ COM, registered in registry)
- Appears as a tile on the lock/logon screen.
- Waits for the service's "authorized" signal, then calls `ICredentialProviderCredentialEvents` / returns a serialized credential so LogonUI logs the user in.

**D. Connectivity layer**
- **LAN:** direct TCP/TLS to the laptop's LAN IP.
- **Internet (your choice):** **Tailscale** on both devices — gives the laptop a stable private IP reachable from anywhere over an encrypted WireGuard mesh, **no port-forwarding, no public exposure.** Strongly recommended over opening a router port.

---

## 3. Unlock sequence (happy path)

1. Laptop is locked. Service is running and listening.
2. User opens Android app, taps **Unlock**.
3. Android shows `BiometricPrompt`. User scans fingerprint. ✅
4. Fingerprint success unlocks the Keystore private key (hardware-enforced).
5. App connects to the laptop (LAN IP or Tailscale IP) over TLS.
6. Service sends a fresh random **nonce** (challenge).
7. App **signs** `nonce + laptopID + timestamp` with the Keystore key and sends the signature + its device ID.
8. Service verifies the signature against the **paired public key** for that device, checks the nonce is unused and fresh (anti-replay).
9. On success, service releases the stored credential to the Credential Provider via named pipe.
10. CP submits the credential to LogonUI → **laptop unlocks.**
11. Service returns "unlocked" to the app; nonce is burned.

---

## 4. Security model

This tool holds the keys to your laptop, so security is the design, not an add-on.

**Enrollment / pairing (one time, done locally & authenticated):**
- Run the app + a laptop-side pairing UI on the same LAN.
- Laptop shows a **QR code** containing: laptop ID + service TLS cert fingerprint + a short pairing secret.
- Phone scans it, generates its Keystore keypair, and sends its **public key** back over the pairing-secret-authenticated channel.
- User enters the Windows password **once** during pairing; the service encrypts and stores it (see below). Password never travels again after this.

**Credential storage on Windows — v1 = ECDH key-release (no usable password at rest):**
- At pairing, the Windows credential is encrypted with a key `K`. `K` is **not** stored whole on the laptop.
- Each unlock, the phone and service do a fresh **ECDH** exchange; the phone's contribution comes from its **fingerprint-gated Keystore key**. Only the resulting shared secret can reconstruct `K`, decrypt the credential, and hand it to the CP over the named pipe.
- Result: the laptop alone holds no usable password — a **live, fingerprinted phone is mathematically required** every unlock. This also binds fingerprint→unlock cryptographically, not just as a UI gate.
- Optional extra layer: also machine-scope DPAPI (`CRYPTPROTECT_LOCAL_MACHINE`) the ciphertext so it's non-portable off this machine.

**Channel security:**
- TLS for all phone↔laptop traffic (service presents a cert pinned during pairing).
- Every unlock is a **challenge/response with a server nonce** → no replay of a captured request.
- Timestamp + short validity window on signed payloads.

**Threat mitigations:**

| Threat | Mitigation |
|---|---|
| Replay of captured unlock | Server nonce, single-use, short TTL |
| MITM on network | TLS + cert pinning from pairing |
| Stolen phone | Fingerprint required per unlock; Keystore key non-exportable, hardware-bound; add app-level PIN fallback lockout |
| Stolen laptop | Attacker still needs a paired phone + fingerprint; credential vault is machine-bound, not portable |
| Rogue app on phone | Keystore key is app-scoped; only your app can use it |
| Lost phone (revocation) | Laptop-side "remove paired device" that deletes the stored public key |

---

## 5. Internet range (your selected scope)

**Recommended: Tailscale (WireGuard mesh).**
- Install Tailscale on the laptop and the phone; sign both into the same tailnet.
- The laptop gets a stable `100.x.y.z` address reachable from the phone anywhere, fully encrypted, with **zero inbound ports opened** on your router. NAT traversal is handled for you.
- The app just targets the laptop's Tailscale IP instead of its LAN IP — same code path.
- Optional hardening: Tailscale ACLs so only your phone can reach the service port.

**Alternative (more work, more risk): self-hosted relay.**
- A small always-on server (VPS) both devices connect out to; it relays the unlock message. Needs its own auth, TLS, and hardening. Only pick this if you can't use a VPN mesh. **Do not** just port-forward the service to the public internet.

---

## 6. Tech stack

| Part | Tech |
|---|---|
| Android app | Kotlin, Android Studio, `androidx.biometric`, Android Keystore, Ktor/OkHttp client |
| Windows service | C++ or Rust or C# (.NET) Windows Service; TLS via Schannel/OpenSSL/.NET |
| Credential Provider | **C++ / COM** (no real alternative — it's a native COM interface). Base it on Microsoft's `SampleCredentialProvider`. |
| Crypto | ECDSA P-256 (sign/verify), TLS 1.3 |
| Remote transport | Tailscale |
| Pairing | QR (ZXing on Android) |

> Note: the service and CP can be different languages, but the **Credential Provider must be native C++/COM**. Budget the most time here — it's the hardest, least-forgiving component.

---

## 7. Build roadmap (phased milestones)

**Phase 0 — Setup (0.5 day)**
- Install Android Studio, Visual Studio (Desktop C++ workload), Windows SDK.
- Create repo skeleton (§8). Get Microsoft's Credential Provider sample building & registering.

**Phase 1 — LAN MVP, no biometrics yet (the risky part first)**
- Build `FingerUnlockCP` from the sample; make it auto-submit a hardcoded test credential and confirm it actually unlocks the lock screen.
- Build `FingerUnlockSvc` (LocalSystem) with a named pipe; make a keypress/CLI on the laptop trigger the pipe → CP unlocks.
- **Milestone:** laptop unlocks on a local trigger. This proves the hardest 20%.

**Phase 2 — Phone in the loop (LAN)**
- Android app: plain "Unlock" button → TCP/TLS to service → service signals CP.
- Add pairing (QR) + challenge/response + store real credential in LSA/DPAPI-machine.
- **Milestone:** phone unlocks laptop on same WiFi, cryptographically.

**Phase 3 — Fingerprint gate**
- Add `BiometricPrompt` + Keystore key with `setUserAuthenticationRequired(true)`; sign the challenge with the biometric-gated key; service verifies signature.
- **Milestone:** fingerprint is required and cryptographically enforced.

**Phase 4 — Internet range**
- Install Tailscale on both; app targets Tailscale IP; add ACLs.
- **Milestone:** unlock from mobile data / different network.

**Phase 5 — Hardening & UX**
- Device revocation UI, failure lockouts, wake-on-approach, logging/audit, auto-start robustness, key-release-gated credential (no stored plaintext password).

---

## 8. Suggested repo structure

```
Windows_Fingerprint/
├─ android/                 # Android Studio project (Kotlin)
│   └─ app/…
├─ windows/
│   ├─ FingerUnlockCP/      # C++ COM Credential Provider DLL
│   ├─ FingerUnlockSvc/     # Windows Service (net + crypto + vault)
│   └─ pairing-ui/          # small pairing app (QR + one-time password entry)
├─ shared/                  # protocol spec, message schemas, crypto notes
└─ docs/                    # this design doc, setup instructions
```

---

## 9. Known gotchas

- Credential Provider debugging is painful — it runs in LogonUI. Use a **spare VM / test machine** and a second admin account so a broken CP doesn't lock you out. Always keep the default password provider working as fallback.
- A misregistered CP can make the logon screen unusable → keep a restore point / registry backup and test in a VM first.
- Machine-scope DPAPI protects at rest but is readable by any admin/SYSTEM process on that box — that's why the phone signature + machine binding matter.
- If you change your Windows password, the stored credential must be re-enrolled.
- Tailscale must be running before lock for internet unlock; the service must start at boot as LocalSystem.

---

## 10. Locked decisions (v1) — 2026-08-14

1. **Stack:** **C# (.NET) service** (built-in Windows Service host, `SslStream` TLS, named pipes, `ECDsa`/ECDH, DPAPI) **+ C++/COM Credential Provider** (mandatory — no C# option for the CP).
2. **No stored password:** ECDH key-release is a **v1 requirement** (see §4) — folded into Phases 2–3.
3. **Test VM:** none yet → **set one up before Phase 1.** VirtualBox (free, any edition) + Microsoft's free "Windows 11 dev environment" image. Never debug the CP directly on the daily-driver laptop. Minimum fallback if no VM: second admin account + System Restore point + registry-export of the CP key + keep the default password provider intact.

**Next:** get the VM up, then start **Phase 1** (the Credential Provider) — the highest-risk 20%, proven first.

---

*Sources: Microsoft — [Companion device unlock (deprecated)](https://learn.microsoft.com/en-us/windows/uwp/security/companion-device-unlock), [deprecation issue](https://github.com/MicrosoftDocs/windows-uwp/issues/1833); [Credential Provider primer (dennisbabkin.com)](https://dennisbabkin.com/blog/?t=primer-on-writing-credential-provider-in-windows).*
