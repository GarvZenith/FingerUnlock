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
   the firewall, generates a **token**, and sets the service to **auto-start at logon**
   (hidden). It prints the token + IP and opens the Tailscale download page.
3. Install **Tailscale** on the PC + phone (for internet unlock).
4. In the phone app → **Add laptop** → enter the IP + token → **Detect** → **Pair**.
5. Lock with **Win+L** to test.

## Uninstall
Run **`uninstall.ps1`** as admin, then reboot.

## Notes
- The service auto-starts in the user session (needed for lock detection) with
  elevated rights (needed to bind the HTTP port).
- Cold-boot (before any login) unlock is out of scope here — this covers lock/unlock
  after login, which is the common case.
- No password is entered by the installer; the credential provider uses the account
  you're already signed into on the lock screen.
