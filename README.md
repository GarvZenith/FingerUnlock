# FingerUnlock

Unlock a Windows laptop from an Android phone using the phone's fingerprint —
"Google-prompt" style: lock the PC and your phone gets a **Yes/No** notification;
tap Yes, scan your fingerprint, and the laptop unlocks — over LAN or, via
Tailscale, from anywhere on the internet.

## How it works
```
Windows locks  ─▶  C# service detects it (SessionSwitch)  ─▶  Expo push to phone
                                                                     │
   phone: "Unlock <PC>?  [Yes] [No]"  ◀───────────────────────────────┘
        │  Yes → fingerprint → POST /approve (one-time nonce)
        ▼
   service writes unlock.flag  ─▶  Credential Provider (lock screen)  ─▶  UNLOCK
```

## Repo layout
```
├─ FingerUnlock_Design.md          # architecture + roadmap
├─ docs/                           # build & test guides (Phase 1, Phase 3)
├─ windows/FingerUnlockCP/         # C++ COM credential provider (unlocks Windows)
├─ windows/FingerUnlockSvc/        # C# service: lock-detect + push + approve/deny
├─ FingerUnlockApp/                # Expo / React Native app (push + fingerprint)
└─ shared/                         # protocol + crypto notes            [TODO]
```

## Status
- ✅ **Phase 1** — credential provider unlocks Windows (manual tile).
- ✅ **Phase 1b** — auto-unlock when the `unlock.flag` signal appears.
- ✅ **Phase 2** — C# HTTP service + Expo app; phone fingerprint unlocks over LAN.
- ✅ **Phase 3** — **push approval**: lock the PC → phone Yes/No push → fingerprint → unlock.
- ✅ **Phase 4** — **Tailscale internet range**: unlock from anywhere (mobile data / any network). ✔ tested
- 🚧 **Phase 3b** — **multi-laptop manager** (one phone, many PCs) · **Settings** screen with pencil-edit + save/discard · **auto-detected PC name** (`/info`) · **tap a PC card → fingerprint → unlock** (toast feedback; skips + says "already unlocked" if the PC isn't locked, via `/info` `locked` state) · auto-updater (EAS Update, loop-safe) · encrypted saved config · Install-Tailscale button. Pending: true sticky notification + headless + full-screen call-style prompt (all need native prebuild).
- ✅ **Cold-boot unlock** — the push service runs as a **boot-time LocalSystem Windows service** with **WTS session detection** (`OnSessionChange`), so it's alive at the logon screen right after a **restart**: reboot → phone push / card-tap → fingerprint → the credential provider **logs you in** (`CPUS_LOGON`, no manual password). Console/dev mode still uses `SessionSwitch` unchanged. ✔ tested
- ✅ **Hardening — phone-vault ECDH**: the Windows password is **no longer stored on the PC** (`config.ini` password is blank). It lives only on the phone (fingerprint-gated), and each unlock sends it **encrypted** (P-256 ECDH → HKDF → AES-256-GCM) to the service (`/pair2`, `/challenge`, encrypted `/approve`), which decrypts in RAM and hands it to the CP via a one-shot DPAPI `cred.bin`. A stolen powered-off laptop reveals nothing. ✔ tested (see `claude/Stage2_ECDH_Design.md`). *Future: ephemeral-ECDH forward secrecy (v2).*
- 🚧 **Packaging** — one-click **`install.ps1`** (registers CP, installs the boot-SYSTEM service, generates a token, opens firewall + Tailscale) + **self-contained service EXE** (`publish.bat`). Phone = prebuilt APK. See `docs/Packaging.md`.

## Build & test
- Credential provider + service: see `docs/Phase1_Build_and_Test.md`.
- Push app (FCM + EAS build): see `docs/Phase3_Push_Setup.md`.
Develop and test in a VM with snapshots — a broken credential provider can lock the logon screen.

## Tech
C++/COM credential provider · C# (.NET 8) service · Expo / React Native app
(expo-notifications + expo-local-authentication) · Expo push / FCM.

## ⚠️ Security
- VM-only development with snapshots.
- `config.ini` and the Firebase service-account key are gitignored — never commit them. (The account **password is now blank** in `config.ini`; it lives only on the phone.)
- The Windows password is delivered per-unlock via **ECDH-encrypted** channel (P-256 / HKDF-SHA256 / AES-256-GCM); it is never at rest on the PC. The shared-secret **token** still authenticates requests over Tailscale/LAN.

## License
MIT — see [LICENSE](LICENSE).
