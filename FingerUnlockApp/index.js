import { registerRootComponent } from 'expo';
import messaging from '@react-native-firebase/messaging';
import notifee from '@notifee/react-native';
import { showCall } from './fullscreen';
import App from './App';

// FCM data message while the app is in the BACKGROUND or KILLED -> full-screen call.
// (Foreground messages are handled inside App.js.)
try {
  messaging().setBackgroundMessageHandler(async (msg) => {
    try { await showCall(msg?.data); } catch (e) { console.log('Background call error:', e); }
  });
} catch (e) {
  console.log('FCM setBackgroundMessageHandler init error:', e);
}

// Notifee requires a background event handler to be registered at the top level.
try {
  notifee.onBackgroundEvent(async () => {});
} catch (e) {
  console.log('Notifee onBackgroundEvent init error:', e);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
registerRootComponent(App);
