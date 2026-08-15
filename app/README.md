# FingerUnlock — Android app (Expo)

Phase 2b: fingerprint on the phone → HTTP `POST /unlock` to the laptop service.

## Create the project (once)
```
npx create-expo-app FingerUnlockApp
cd FingerUnlockApp
npx expo install expo-local-authentication
```
Then replace the generated `App.js` with the `App.js` from this folder.

## Run (dev, via Expo Go)
```
npx expo start
```
Install **Expo Go** on your phone (Play Store), make sure phone + laptop are on
the **same WiFi**, and scan the QR code. The app opens instantly — no build.

In the app: enter the laptop's **LAN IP** and the **token** (same as
`C:\FingerUnlock\service.ini`), then tap **Unlock Laptop**. Fingerprint prompt →
laptop unlocks.

## Later: standalone APK (no Expo Go)
```
npm install -g eas-cli
eas build -p android --profile preview
```
Produces an installable `.apk` you keep on the phone permanently.

## Notes
- Cleartext HTTP works in Expo Go dev. Phase 3 switches to HTTPS + ECDH.
- Networking prerequisites (VM bridged adapter, firewall rule) are in the chat steps.
