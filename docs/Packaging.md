# Packaging — turnkey Windows install

Turns the manual setup (build DLL, copy files, register, run service) into a
one-command install for end users. The phone side stays the prebuilt APK.

## Build the distributable (developer, once per release)
Open **"x64 Native Tools Command Prompt for VS 2022"** (needs `cl.exe` + `dotnet`), then:
```
cd windows\installer
publish.bat
```
This produces **`windows\installer\dist\`** containing:
- `FingerUnlockCP.dll` — credential provider
- `FingerUnlockSvc.exe` — self-contained service (no .NET needed on the target)
- `install.ps1`, `uninstall.ps1`, `run-hidden.vbs`

Zip `dist\` and attach it to a **GitHub Release** (binaries aren't committed to the repo).

## Install (end user)
1. Download + unzip the release.
2. Right-click **`install.ps1`** → **Run with PowerShell** (as **Administrator**).
   It copies files to `C:\FingerUnlock`, registers the credential provider, opens
   the firewall, generates a **token**, and installs the push service as a
   **boot-time LocalSystem Windows service**. It prints the token + IP and opens
   the Tailscale download page.
3. Install **Tailscale** on the PC + phone (for internet unlock).
4. In the phone app → **Add laptop** → enter the IP + token → **Detect** → **Pair**.
5. Lock with **Win+L** to test.

## Uninstall
Run **`uninstall.ps1`** as admin, then reboot.

## Notes
- The service runs as a **boot-time LocalSystem service** (session 0), so it's up at
  the logon screen. Lock/logon/logoff are detected via **WTS session notifications**
  (`OnSessionChange`) — the only mechanism that works in session 0.
- **Cold-boot is supported**: after a restart, reboot → phone → fingerprint → the
  credential provider logs you in (`CPUS_LOGON`) using the account in `config.ini`.
- The installer writes only `service.ini` (port/token). `config.ini`
  (username + password, used by the credential provider) is created by you and is
  gitignored. Removing that at-rest password is the ECDH hardening step.
