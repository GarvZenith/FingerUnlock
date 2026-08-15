# FingerUnlock

Unlock a Windows laptop from an Android phone using the phone's fingerprint —
over LAN and (via Tailscale) the internet.

The phone's fingerprint releases a hardware-backed key; the phone then proves
itself to a service on the laptop, which signals a **custom Windows Credential
Provider** to unlock the machine. No password is typed, and (from Phase 2) no
usable password is stored at rest.

## How it works
```
Android (fingerprint → Keystore key)
        │  signed challenge over TLS (LAN / Tailscale)
        ▼
Windows Service (LocalSystem: network + crypto + credential vault)
        │  named-pipe / flag signal
        ▼
Credential Provider DLL (on the lock screen) → UNLOCK
```

## Repo layout
```
├─ FingerUnlock_Design.md          # full architecture + roadmap
├─ docs/Phase1_Build_and_Test.md   # ← build & test the credential provider
├─ windows/FingerUnlockCP/         # C++ COM credential provider (Phase 1 / 1b)
├─ windows/FingerUnlockSvc/        # C# service (Phase 2)            [TODO]
├─ android/                        # Kotlin app, BiometricPrompt (Phase 2+) [TODO]
└─ shared/                         # protocol + crypto notes          [TODO]
```

## Status
- ✅ **Phase 1** — credential provider unlocks Windows on a manual tile click.
- 🚧 **Phase 1b** — auto-unlock when an external signal (`unlock.flag`) appears.
- ⬜ **Phase 2** — C# service + Android app, pairing + challenge/response, ECDH-gated vault.
- ⬜ **Phase 3** — fingerprint gate. **Phase 4** — Tailscale internet range.

## Build & test
See **`docs/Phase1_Build_and_Test.md`**. Build with the VS 2022 *x64 Native Tools*
prompt (`build.bat`), deploy to `C:\FingerUnlock\`, register with `register.reg`.

## ⚠️ Security
This project can unlock a Windows machine, so treat it carefully:
- **Develop/test only in a VM with snapshots.** A broken credential provider can
  make the logon screen unusable.
- Never commit real credentials — `config.ini` is gitignored.
- Phase 1's plaintext `config.ini` is **test-only**; Phase 2 replaces it with an
  encrypted, fingerprint-gated (ECDH) vault.

## License
MIT — see [LICENSE](LICENSE).
