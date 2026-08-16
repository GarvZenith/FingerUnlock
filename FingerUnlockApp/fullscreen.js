// Step B — raise a full-screen "incoming unlock" call via Notifee.
// Used from the FCM background/killed handler (index.js) and the foreground
// handler (App.js). The full-screen intent launches the app over the lock screen;
// the app then reads getInitialNotification() and shows the ring UI.
//
// Also provides the sticky foreground service notification (Phase 3b) that keeps
// the app alive in the background so FCM messages are received instantly.
import notifee, { AndroidImportance, AndroidVisibility, AndroidCategory } from '@notifee/react-native';

// ---- Unlock channel (high-importance, sound + vibration + bypass DND) ----
export async function ensureChannel() {
  return notifee.createChannel({
    id: 'unlock_call_v3',
    name: 'Incoming Unlock Calls',
    importance: AndroidImportance.HIGH,
    visibility: AndroidVisibility.PUBLIC,
    sound: 'default',
    vibration: true,
    vibrationPattern: [300, 500, 300, 500],
    lights: true,
    lightColor: '#3b6ef5',
    bypassDnd: true,
  });
}

// ---- Service channel (low-importance, silent — for the sticky notification) ----
export async function ensureServiceChannel() {
  return notifee.createChannel({
    id: 'service_v3',
    name: 'Background service',
    importance: AndroidImportance.LOW,
    visibility: AndroidVisibility.PUBLIC,
    sound: undefined,
    vibration: false,
  });
}

// ---- Full-screen incoming-unlock call ----
export async function showCall(data) {
  if (!data) return;
  if (data.type === 'cancel') { await notifee.cancelAllNotifications(); return; }
  if (data.type !== 'unlock') return;
  await ensureChannel();
  await notifee.displayNotification({
    id: 'unlock_incoming',
    title: `Unlock ${data.machine || 'PC'}?`,
    body: 'Tap to approve with your fingerprint',
    data,
    android: {
      channelId: 'unlock_call_v3',
      importance: AndroidImportance.HIGH,
      category: AndroidCategory.CALL,
      fullScreenAction: { id: 'default', launchActivity: 'default' },
      pressAction: { id: 'default', launchActivity: 'default' },
      asForegroundService: true,
      autoCancel: true,
      timeoutAfter: 45000,
      showTimestamp: true,
      color: '#3b6ef5',
      actions: [
        {
          title: '☝ Unlock',
          pressAction: { id: 'yes', launchActivity: 'default' },
        },
        {
          title: '✕ Decline',
          pressAction: { id: 'no' },
        },
      ],
    },
  });
}

// ---- Sticky foreground notification (Phase 3b) ----
// Keeps the app process alive so FCM messages arrive instantly and the
// full-screen intent fires even when the app is backgrounded or swiped away.
const STICKY_ID = 'fu-service';

export async function showStickyNotification() {
  try {
    await ensureServiceChannel();
    await notifee.displayNotification({
      id: STICKY_ID,
      title: 'FingerUnlock active',
      body: 'Listening for unlock requests',
      android: {
        channelId: 'service_v3',
        importance: AndroidImportance.LOW,
        ongoing: true,                    // non-dismissable
        asForegroundService: true,        // keeps the process alive
        pressAction: { id: 'default', launchActivity: 'default' },
        color: '#3b6ef5',
      },
    });
  } catch (e) {
    console.log('Sticky notification error:', e);
  }
}

export async function hideStickyNotification() {
  try { await notifee.cancelNotification(STICKY_ID); } catch {}
}

// ---- Headless foreground service runner (Phase 3b) ----
// Notifee requires a foreground service callback to be registered at the
// top level. This runner is invoked when the sticky notification is displayed
// with asForegroundService: true. It simply keeps the JS context alive —
// all actual work (FCM listeners, etc.) is set up in App.js and index.js.
try {
  notifee.registerForegroundService(() => {
    return new Promise(() => {
      // Intentionally never resolves — the foreground service runs until
      // the notification is cancelled (hideStickyNotification) or the app
      // is fully stopped. The JS context stays alive so FCM onMessage,
      // setBackgroundMessageHandler, and all React state continue to work.
    });
  });
} catch (e) {
  console.log('registerForegroundService error:', e);
}


