import { useEffect, useRef, useState } from 'react';
import {
  Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Platform, Linking,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const TAILSCALE_PLAY = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';
const PORT = '5599';

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

  const line = (s) => setLog((p) => (`• ${s}\n` + p).split('\n').slice(0, 12).join('\n'));

  // ---- Persist IP + token ----
  const loaded = useRef(false);
  useEffect(() => {
    (async () => {
      const [i, t] = await Promise.all([
        SecureStore.getItemAsync('fu_ip'), SecureStore.getItemAsync('fu_token'),
      ]);
      if (i) setIp(i);
      if (t) setToken(t);
      loaded.current = true;
    })();
  }, []);
  useEffect(() => { if (loaded.current) SecureStore.setItemAsync('fu_ip', ip).catch(() => {}); }, [ip]);
  useEffect(() => { if (loaded.current && token) SecureStore.setItemAsync('fu_token', token).catch(() => {}); }, [token]);

  // Always read creds from storage (state may not be ready on a cold start).
  async function getCreds() {
    const i = (await SecureStore.getItemAsync('fu_ip')) || ip;
    const t = (await SecureStore.getItemAsync('fu_token')) || token;
    return { ip: i, token: t };
  }
  async function post(path, extra) {
    const { ip, token } = await getCreds();
    return fetch(`http://${ip}:${PORT}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extra, token }),
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

  // ---- Auto-update (EAS Update), loop-safe ----
  const updating = useRef(false);
  async function runUpdate() {
    if (updating.current) return;
    updating.current = true;
    try {
      await Notifications.dismissAllNotificationsAsync();
      const f = await Updates.fetchUpdateAsync();
      if (f.isNew) { await Updates.reloadAsync(); }
      else { line('already up to date'); updating.current = false; }
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

  // Handle a notification response ONCE (works warm AND on cold start).
  async function handleResponse(resp) {
    if (!resp) return;
    const id = resp.notification.request.identifier;
    const last = await SecureStore.getItemAsync('fu_lastNotif');
    if (last === id) return;                 // already handled this notification
    await SecureStore.setItemAsync('fu_lastNotif', id);

    const d = resp.notification.request.content.data || {};
    if (d.type === 'update') { runUpdate(); return; }
    if (d.type !== 'unlock') return;
    if (resp.actionIdentifier === 'no') deny(d.nonce);
    else approve(d.nonce);                    // "Yes" button OR tapping the notification
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

      // If a tap COLD-STARTED the app, handle it now.
      const coldResp = await Notifications.getLastNotificationResponseAsync();
      handleResponse(coldResp);

      checkForUpdate(false);
    })();

    const recv = Notifications.addNotificationReceivedListener((n) => {
      if ((n.request.content.data || {}).type === 'cancel') Notifications.dismissAllNotificationsAsync();
    });
    const resp = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => { recv.remove(); resp.remove(); };
  }, []);

  async function pair() {
    try { const res = await post('register', { pushToken }); line(res.ok ? '✅ paired' : `pair ${res.status}`); }
    catch (e) { line('pair err: ' + e.message); }
  }

  return (
    <ScrollView contentContainerStyle={styles.c}>
      <Text style={styles.title}>🔓 FingerUnlock</Text>

      <Text style={styles.label}>Laptop IP (saved automatically)</Text>
      <TextInput style={styles.input} value={ip} onChangeText={setIp}
        autoCapitalize="none" keyboardType="numbers-and-punctuation" />

      <Text style={styles.label}>Token (saved securely)</Text>
      <TextInput style={styles.input} value={token} onChangeText={setToken}
        autoCapitalize="none" secureTextEntry />

      <TouchableOpacity style={styles.btn} onPress={pair}>
        <Text style={styles.btnText}>Pair this phone</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.btnAlt} onPress={() => Linking.openURL(TAILSCALE_PLAY)}>
        <Text style={styles.btnAltText}>Install Tailscale (for unlock over internet)</Text>
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
