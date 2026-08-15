# Phase 1 — Build & Test the FingerUnlock Credential Provider

**Goal of Phase 1:** prove that our custom Credential Provider can unlock Windows.
You lock the VM, pick the **FingerUnlock** tile, click **Unlock**, and it logs you
in using a stored credential — *no typing*. Once this works, the phone + fingerprint
+ service get layered on top. This is the riskiest 20%, so we prove it first.

> ⚠️ **Do all of this inside the VirtualBox VM, never on your real laptop.**
> A broken credential provider can make the logon screen unusable. In a VM,
> recovery is one click (restore snapshot). **Take a snapshot at every step marked 📸.**

---

## Part A — Create the Windows VM

You have two options. **Option A1 is the fastest.**

### Option A1 — Microsoft's ready-made dev VM (recommended)
1. Download the **"Windows 11 development environment"** VM (VirtualBox flavor) from Microsoft's *Windows dev environments* page. It's pre-activated.
2. In VirtualBox: **File → Import Appliance** → select the downloaded `.ova` → Import.
3. Start it. It logs in as user **User** (no password by default).
4. **Set a password** (Phase 1 unlock needs one). Open Command Prompt and run:
   ```
   net user User Test@12345
   ```
   Remember this — it goes in `config.ini` later.

### Option A2 — Clean install from ISO
1. Download the **Windows 11 Disk Image (ISO)** from Microsoft.
2. VirtualBox → **New**: Name `FingerUnlock-Test`, Type *Windows 11 64-bit*, RAM **4096 MB+**, CPUs **2+**, disk **60 GB**.
3. In the VM's **Settings → System**: enable **EFI**, and enable **TPM 2.0** and **Secure Boot** (Windows 11 requires these; VirtualBox 7 supports them).
4. Attach the ISO and install. **Important:** create a **LOCAL account with a password** (not a Microsoft account) — it makes Phase 1 simple. To force local-account setup, at "Let's connect you to a network" you can use the offline path, or install the Pro edition.

### Both options
- (Optional) Install **VirtualBox Guest Additions** (Devices → Insert Guest Additions CD) so you can drag-drop files and use shared folders.
- 📸 **Take a snapshot now** → name it `clean-install`.

---

## Part B — Install the C++ build tools (inside the VM)

1. Download **Visual Studio 2022 Community** (free).
2. In the installer, tick the **"Desktop development with C++"** workload. Make sure the **Windows 11 SDK** is included (it is, by default).
3. Install. This gives you `cl.exe` and the SDK headers (`credentialprovider.h`, `ntsecapi.h`).

---

## Part C — Get the code in and build

1. Copy the folder **`windows/FingerUnlockCP/`** (all the `.cpp/.h`, `build.bat`, `.def`, `.reg`, `config.ini.example`) into the VM — e.g. to `C:\src\FingerUnlockCP\`.
   (Drag-drop with Guest Additions, a shared folder, or just download the files.)
2. Open **"x64 Native Tools Command Prompt for VS 2022"** (Start menu → search it). This is important — it puts the 64-bit `cl.exe` + SDK on PATH. A normal cmd window won't work.
3. Build:
   ```
   cd C:\src\FingerUnlockCP
   build.bat
   ```
4. Success looks like: `BUILD OK -> FingerUnlockCP.dll`.
   If you get compile/link errors, **copy the full output back to me** — first builds usually need one or two small fixes and we'll knock them out together.

---

## Part D — Deploy & register

1. Create the install folder and copy the DLL + config:
   ```
   mkdir C:\FingerUnlock
   copy FingerUnlockCP.dll  C:\FingerUnlock\
   copy config.ini.example  C:\FingerUnlock\config.ini
   ```
2. Edit **`C:\FingerUnlock\config.ini`**: set `username` and `password` to the VM's local account (e.g. `User` / `Test@12345`). Leave `domain=.`.
3. 📸 **Take a snapshot** → name it `before-register`. *(This is your undo button.)*
4. Double-click **`register.reg`** → Yes. (It writes the CLSID + registers the provider. It does **not** disable the default password tile.)
5. **Sign out** (or reboot) so LogonUI reloads the providers.

---

## Part E — Test the unlock 🎯

1. Lock the VM: **Start → user icon → Lock**, or press **Win+L** *inside* the VM
   (in VirtualBox use **Input → Keyboard → Insert Win+L**, since your host may grab it).
2. On the lock screen, click **"Sign-in options"** (bottom center) — you'll see an
   extra tile/icon for **FingerUnlock** alongside the normal password one.
3. Select the **FingerUnlock** tile → click **Unlock**.
4. ✅ **Pass:** Windows logs in without you typing the password.
   ❌ If it shows an error string, note it — that text comes straight from our code
   (e.g. "config.ini missing username") and tells us exactly what to fix.

That's Phase 1 proven: an external selection drives a real unlock. 🎉

---

## Part F — If the logon screen breaks (recovery)

In order of ease:
1. **Restore the `before-register` snapshot** in VirtualBox. Done. (This is why we snapshot.)
2. Or boot the VM, and from *any working* path run **`unregister.reg`** → reboot. The default password tile always still works, so you can log in to do this.
3. Or (last resort) boot the VM from a Windows ISO → **Repair → Command Prompt**, then delete the CP key from the offline registry hive.

---

## What Phase 1 does *not* do yet (coming next)

- **Phase 1b:** replace "click Unlock" with an **external trigger** — the provider watches for a signal (a flag file first, then the local service) and auto-submits. This is the bridge to the phone.
- **Phase 2:** C# Windows Service + Android app do the pairing and challenge/response over the network; the plaintext `config.ini` is replaced by the **ECDH-gated vault** (no usable password at rest).
- **Phase 3:** fingerprint (`BiometricPrompt`) gates the phone's signing key.
- **Phase 4:** Tailscale for internet range.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| FingerUnlock tile doesn't appear | `register.reg` path wrong, or DLL not at `C:\FingerUnlock\FingerUnlockCP.dll`; must be the **64-bit** DLL (built from x64 prompt). Sign out/in again. |
| "The user name or password is incorrect" | `config.ini` creds don't match the account, or you used a Microsoft-account email. Use a **local** account + its password; `domain=.`. |
| Clicking Unlock does nothing / tile disappears then returns | Serialization issue — send me the exact behavior; likely the auth-package or pack step. |
| `build.bat`: `cl is not recognized` | You're not in the **x64 Native Tools Command Prompt for VS 2022**. |
| Link errors on `LsaConnectUntrusted` / `SHStrDupW` | Missing lib — confirm `secur32.lib` and `shlwapi.lib` are on the link line (they're in `build.bat`). |
| Build errors mentioning `credentialprovider.h` | Windows SDK not installed with the C++ workload — rerun VS installer and add it. |
