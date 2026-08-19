# 🔓 FingerUnlock — Complete End-to-End User Setup Guide

A complete guide for any new user to install and configure **FingerUnlock** on their Windows PC and Android phone, including **Tailscale** for unlocking from anywhere over the internet (5G / Mobile Data / Remote Wi-Fi).

---

## 📋 Prerequisites

- **Windows PC / Laptop:** Windows 10 or 11 (64-bit).
- **Android Phone:** Android 10+ with Biometric / Fingerprint sensor.
- **Tailscale Account:** Free account at [tailscale.com](https://tailscale.com) (for internet unlock).

---

## 🛠️ Step 1: Windows PC Installation (1-Click Installer)

1. **Download Repository / Release:**
   Clone or download the project from GitHub:
   ```cmd
   git clone https://github.com/GarvZenith/FingerUnlock.git
   ```

2. **Run Installer as Administrator:**
   - Search for **PowerShell** in the Start Menu, right-click, and select **Run as Administrator**.
   - Navigate to the `windows\installer` folder:
     ```powershell
     cd E:\Project\Windows_Fingerprint\windows\installer
     .\install.ps1
     ```

3. **What `install.ps1` does automatically:**
   - Creates `C:\FingerUnlock\` and copies the core binaries.
   - Registers the C++ Credential Provider (`FingerUnlockCP.dll`) in Windows Registry.
   - Installs `FingerUnlockSvc.exe` as a boot-time `LocalSystem` Windows Service (`FingerUnlockSvc`).
   - Opens Windows Firewall port `5599`.
   - Creates `config.ini` with your Windows username automatically.
   - Generates a unique secure Secret Token in `C:\FingerUnlock\service.ini`.

4. **Note down your details printed on PowerShell:**
   - **Secret Token:** (e.g., `222052915d464fb59c59383ddc38d3e31f6cd4b...`)
   - **Service Status:** Running (`Get-Service FingerUnlockSvc`)

---

## 🌐 Step 2: Tailscale Setup (Unlock Over Internet / Mobile Data)

Tailscale connects your phone and laptop into a secure private network so you can unlock your PC over 5G mobile data or any remote Wi-Fi.

### On your Windows PC:
1. Download Tailscale for Windows: [tailscale.com/download/windows](https://tailscale.com/download/windows)
2. Install and launch Tailscale from the taskbar system tray.
3. Log in with your **Google** or **Microsoft** account.
4. Note your **Tailscale IPv4 Address** (e.g., `100.x.y.z`).

### On your Android Phone:
1. Install **Tailscale** from Google Play Store.
2. Log in with the **SAME Google / Microsoft account** used on the PC.
3. Toggle the VPN switch **ON (Connected)**.

---

## 📱 Step 3: Android Phone App Installation

1. **Install APK:**
   - Download the prebuilt `FingerUnlock.apk` from GitHub Releases and install it on your phone.

2. **Configure Android System Permissions (Crucial for Full-Screen Call Popup):**
   - Open phone **Settings → Apps → FingerUnlock → Permissions**:
     - ✅ **Display over other apps** (Allow)
     - ✅ **Display pop-up windows in background / Show on Lock screen** (Allow)
   - Open phone **Settings → Apps → FingerUnlock → Manage notifications**:
     - Tap **Incoming Unlock Calls** category → Enable **Banner** & **Lock screen**.

---

## 🔑 Step 4: One-Time Pairing & Usage

1. Open **FingerUnlock** app on your phone.
2. Tap **⚙ Settings → + Add laptop**:
   - **Laptop IP:** Enter your PC's **Tailscale IP** (`100.x.y.z`) [or LAN IP `192.168.x.x` if on same Wi-Fi].
   - **Token:** Enter the Secret Token (from `C:\FingerUnlock\service.ini`).
   - **Windows Password:** Enter your Windows login password.
3. Tap **Detect PC name** → Tap **Pair this phone** → Tap **Save changes**.

---

## 🧪 Testing Your Setup

1. Lock your Windows PC (**`Win + L`**).
2. **Option A (Notification Call Popup):** When PC locks, phone gets an incoming call-style ringing UI → Tap **Accept (☝)** → Scan Fingerprint → **PC Unlocks!**
3. **Option B (On-Demand Card Tap):** Open phone app → Tap the laptop card → Scan Fingerprint → **PC Unlocks!**

---

## ❓ Troubleshooting & FAQs

- **Service check:** Run `Get-Service FingerUnlockSvc` in PowerShell (Status should be `Running`).
- **Log inspection:** Check `C:\FingerUnlock\service.log` for connection events.
- **Uninstall:** Run `uninstall.ps1` as Administrator in `windows\installer`.
