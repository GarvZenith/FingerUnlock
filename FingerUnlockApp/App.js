import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Platform,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

export default function App() {
  const [ip, setIp] = useState('192.168.1.50');
  const [token, setToken] = useState('');
  const [pushToken, setPushToken] = useState('');
  const [log, setLog] = useState('starting…');
  const PORT = '5599';

  const cfg = useRef({ ip, token });
  useEffect(() => { cfg.current = { ip, token }; }, [ip, token]);
  const line = (s) => setLog((p) => (`• ${s}\n` + p).split('\n').slice(0, 12).join('\n'));

  async function post(path, bodyObj) {
    const { ip, token } = cfg.current;
    return fetch(`http://${ip}:${PORT}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyObj, token }),
    });
  }

  async function approve(nonce) {
    try {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock laptop' });
      if (!r.success) { line('fingerprint cancelled'); return; }
      const res = await post('approve', { nonce });
      line(res.ok ? '✅ unlocked' : `approve failed ${res.status}`);
      await Notifications.dismissAllNotificationsAsync();
    } catch (e) { line('approve err: ' + e.message); }
  }
  async function deny(nonce) {
    try { await post('deny', { nonce }); } catch {}
    await Notifications.dismissAllNotificationsAsync();
    line('denied');
  }

  // ---- Auto-update (EAS Update) — loop-safe ----
  const updating = useRef(false);
  async function runUpdate() {
    if (updating.current) return;
    updating.current = true;
    try {
      await Notifications.dismissAllNotificationsAsync();
      await Notifications.scheduleNotificationAsync({
        content: { title: 'FingerUnlock', body: 'Installing update…', sticky: true }, trigger: null,
      });
      const f = await Updates.fetchUpdateAsync();
      if (f.isNew) {
        await Updates.reloadAsync();          // restarts on the new version (clears the notification)
      } else {
        line('already up to date');
        await Notifications.dismissAllNotificationsAsync();
        updating.current = false;
      }
    } catch (e) { line('update err: ' + e.message); updating.current = false; }
  }
  async function checkForUpdate(manual) {
    try {
      if (!Updates.isEnabled) { if (manual) line('updates not enabled (dev build)'); return; }
      const r = await Updates.checkForUpdateAsync();
      if (r.isAvailable) {
        line('update available');
        await Notifications.scheduleNotificationAsync({
          content: { title: 'FingerUnlock update available', body: 'Tap “Update now” to install',
                     categoryId: 'update', data: { type: 'update' } }, trigger: null,
        });
      } else if (manual) line('no update');
    } catch (e) { if (manual) line('update check err: ' + e.message); }
  }

  useEffect(() => {
    (async () => {
      await Notifications.requestPermissionsAsync();
      await Notifications.setNotificationCategoryAsync('unlock', [
        { identifier: 'yes', buttonTitle: 'Yes, unlock', options: { opensAppToForeground: true } },
        { identifier: 'no',  buttonTitle: 'No',          options: { opensAppToForeground: false, isDestructive: true } },
      ]);
      await Notifications.setNotificationCategoryAsync('update', [
        { identifier: 'update', buttonTitle: 'Update now', options: { opensAppToForeground: true } },
      ]);
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('unlock', {
          name: 'Unlock requests', importance: Notifications.AndroidImportance.MAX, sound: 'default',
        });
      }
      try {
        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        const t = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
        setPushToken(t);
        line('push token ready');
      } catch (e) { line('push token err: ' + e.message); }
      checkForUpdate(false);   // loop-safe: one check per launch
    })();

    const recv = Notifications.addNotificationReceivedListener((n) => {
      if ((n.request.content.data || {}).type === 'cancel') Notifications.dismissAllNotificationsAsync();
    });
    const resp = Notifications.addNotificationResponseReceivedListener((r) => {
      const d = r.notification.request.content.data || {};
      const a = r.actionIdentifier;
      if (d.type === 'update') { runUpdate(); return; }
      if (d.type !== 'unlock') return;
      if (a === 'no') deny(d.nonce);
      else approve(d.nonce);           // 'yes' button or tapping the notification
    });
    return () => { recv.remove(); resp.remove(); };
  }, []);

  async function pair() {
    try { const res = await post('register', { pushToken }); line(res.ok ? '✅ paired' : `pair ${res.status}`); }
    catch (e) { line('pair err: ' + e.message); }
  }

  return (
    <ScrollView contentContainerStyle={styles.c}>
      <Text style={styles.title}>🔓 FingerUnlock</Text>

      <Text style={styles.label}>Laptop IP</Text>
      <TextInput style={styles.input} value={ip} onChangeText={setIp}
        autoCapitalize="none" keyboardType="numbers-and-punctuation" />

      <Text style={styles.label}>Token</Text>
      <TextInput style={styles.input} value={token} onChangeText={setToken}
        autoCapitalize="none" secureTextEntry />

      <TouchableOpacity style={styles.btn} onPress={pair}>
        <Text style={styles.btnText}>Pair this phone</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.btnAlt} onPress={() => checkForUpdate(true)}>
        <Text style={styles.btnAltText}>Check for update</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Phone push token</Text>
      <Text selectable style={styles.mono}>{pushToken || '…'}</Text>

      <Text style={styles.label}>Log</Text>
      <Text style={styles.mono}>{log}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  c: { backgroundColor: '#0f1220', padding: 24, paddingTop: 60, flexGrow: 1 },
  title: { color: '#fff', fontSize: 30, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  label: { color: '#aab', fontSize: 13, marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: '#1b2030', color: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  btn: { backgroundColor: '#3b6ef5', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 18 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnAlt: { borderColor: '#3b6ef5', borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  btnAltText: { color: '#9ab6ff', fontSize: 14, fontWeight: '600' },
  mono: { color: '#9fd', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', marginTop: 4 },
});
