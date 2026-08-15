# Phase 3 — Push-approval setup (one-time)

Goal: laptop lock → phone gets a **Yes/No push notification** → fingerprint → unlock.
Push needs a **real APK build** (Expo Go can't do Android push) with **FCM** configured.

All commands run on the **host** in `FingerUnlockApp/`.

## 1. Packages
```
cd FingerUnlockApp
npx expo install expo-notifications expo-constants
```
`app.json` is already set (package `com.garv.fingerunlock`, cleartext HTTP, plugins).

## 2. Expo + EAS project
```
npm install -g eas-cli
eas login            # create a free account at expo.dev if needed
eas init             # links the project, writes extra.eas.projectId into app.json
eas build:configure  # creates eas.json (development / preview / production)
```

## 3. Firebase Cloud Messaging (Android push)
1. https://console.firebase.google.com → **Add project**.
2. **Add app → Android**, package name **`com.garv.fingerunlock`** → register → **download `google-services.json`**.
3. Put `google-services.json` in `FingerUnlockApp/`.
4. In `app.json`, add under `"android"`: `"googleServicesFile": "./google-services.json"`.
5. Firebase → **Project settings → Service accounts → Generate new private key** → download the JSON.
6. Upload it to Expo: `eas credentials` → Android → *(preview profile)* → **Push Notifications (FCM V1)** → upload the service-account JSON.

## 4. Build the APK
```
eas build -p android --profile preview
```
Wait for the cloud build → open the link → **download the .apk** → install on the phone (allow "unknown sources").

## 5. Pair + run
- Open the app → allow notifications → a **push token** appears.
- Enter the **laptop IP** + **token** (same as `service.ini`) → tap **Pair** (writes the push token into the laptop's `service.ini` via `/register`). Or paste the push token into `service.ini` manually (`pushtoken=`).
- On the **VM**: rebuild the credential provider (`build.bat` → copy DLL), and run the service (admin `dotnet run`).

## 6. Test
Lock the VM (**Win+L**) → phone shows **"Unlock <PC>?"** with **Yes/No** → tap **Yes** → fingerprint → laptop unlocks. 🎉

## Notes / next (Phase 3b)
- **Sticky notification** (stays pinned until Yes/No) + **hide launcher icon** (headless) — added next.
- **Self-hosted auto-updater** — added next (loop-safe).
- Still plaintext HTTP token; HTTPS + ECDH is later hardening.
