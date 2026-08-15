# FingerUnlock

Unlock a Windows laptop from an Android phone using the phone's fingerprint —
"Google-prompt" style: lock the PC and your phone gets a **Yes/No** notification;
tap Yes, scan your fingerprint, and the laptop unlocks. Over LAN today, and
(via Tailscale) the internet next.

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
- ✅ **Phase 3** — **push approval**: lock the PC → phone Yes/No push → fingerprint → unlock (LAN).
- ⬜ **Phase 3b** — headless app (no launcher icon) + sticky notification + self-hosted auto-updater.
- ⬜ **Phase 4** — Tailscale internet range (unlock from anywhere).
- ⬜ **Hardening** — HTTPS + ECDH pairing, no password stored at rest.

## Build & test
- Credential provider + service: see `docs/Phase1_Build_and_Test.md`.
- Push app (FCM + EAS build): see `docs/Phase3_Push_Setup.md`.
Develop and test in a VM with snapshots — a broken credential provider can lock the logon screen.

## Tech
C++/COM credential provider · C# (.NET 8) service · Expo / React Native app
(expo-notifications + expo-local-authentication) · Expo push / FCM.

## ⚠️ Security
- VM-only development with snapshots.
- `config.ini` (Windows password) and the Firebase service-account key are gitignored — never commit them.
- Phase 3 uses a plaintext shared-secret token over LAN HTTP; HTTPS + ECDH is the hardening step.

## License
MIT — see [LICENSE](LICENSE).
