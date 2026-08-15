import { useEffect, useRef, useState } from 'react';
import {
  Text, View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Platform, Linking, Alert, BackHandler, ToastAndroid,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const PORT = '5599';
const TAILSCALE_PLAY = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

// ---- storage (module-level so the cold-start handler can use it) ----
async function loadLaptops() {
  try { const s = await SecureStore.getItemAsync('fu_laptops'); return s ? JSON.parse(s) : []; }
  catch { return []; }
}
async function saveLaptops(list) { await SecureStore.setItemAsync('fu_laptops', JSON.stringify(list)); }

async function postTo(l, path, extra) {
  return fetch(`http://${l.ip}:${PORT}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...extra, token: l.token }),
  });
}

export default function App() {
  const [screen, setScreen] = useState('home');    // home | settings | edit
  const [laptops, setLaptops] = useState([]);
  const [pushToken, setPushToken] = useState('');
  const [draft, setDraft] = useState(null);         // laptop being edited
  const [orig, setOrig] = useState(null);           // original (to detect changes)
  const [status, setStatus] = useState({});         // machine/online per laptop id

  const refresh = async () => setLaptops(await loadLaptops());
  useEffect(() => { refresh(); }, []);

  // ---- unlock handling ----
  async function handleUnlock(machine, nonce, action) {
    const list = await loadLaptops();
    const lap = list.find((l) => l.machine && machine && l.machine === machine)
      || (list.length === 1 ? list[0] : null);
    if (!lap) return;
    if (action === 'no') {
      try { await postTo(lap, 'deny', { nonce }); } catch {}
      await Notifications.dismissAllNotificationsAsync();
      return;
    }
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: `Unlock ${lap.name || lap.machine || 'laptop'}` });
    if (!r.success) return;
    try { await postTo(lap, 'approve', { nonce }); } catch {}
    await Notifications.dismissAllNotificationsAsync();
  }

  // Tap a laptop card -> fingerprint -> unlock on demand (uses the token-only /unlock).
  async function unlockNow(l) {
    // If the PC isn't locked, don't send an unlock — just a small toast.
    try {
      const info = await postTo(l, 'info', {});
      if (info.ok) {
        const j = JSON.parse(await info.text());
        if (j.locked === false) { ToastAndroid.show('PC is already unlocked', ToastAndroid.SHORT); return; }
      }
    } catch {}
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: `Unlock ${l.name || l.machine || 'laptop'}` });
    if (!r.success) return;
    try {
      const res = await postTo(l, 'unlock', {});
      ToastAndroid.show(res.ok ? `Unlock sent to ${l.name || l.machine || l.ip}` : `Failed (${res.status})`, ToastAndroid.SHORT);
    } catch (e) { ToastAndroid.show('Failed: ' + e.message, ToastAndroid.SHORT); }
  }

  // ---- auto-update ----
  const updating = useRef(false);
  async function runUpdate() {
    if (updating.current) return; updating.current = true;
    try {
      await Notifications.dismissAllNotificationsAsync();
      const f = await Updates.fetchUpdateAsync();
      if (f.isNew) await Updates.reloadAsync(); else updating.current = false;
    } catch { updating.current = false; }
  }
  async function checkForUpdate(manual) {
    try {
      if (!Updates.isEnabled) { if (manual) Alert.alert('Updates', 'Not enabled (dev build)'); return; }
      const r = await Updates.checkForUpdateAsync();
      if (r.isAvailable) {
        await Notifications.scheduleNotificationAsync({
          content: { title: 'FingerUnlock update available', body: 'Tap “Update now”',
                     categoryId: 'update', data: { type: 'update' } }, trigger: null });
      } else if (manual) Alert.alert('Updates', 'You are up to date');
    } catch (e) { if (manual) Alert.alert('Updates', e.message); }
  }

  async function handleResponse(resp) {
    if (!resp) return;
    const id = resp.notification.request.identifier;
    const last = await SecureStore.getItemAsync('fu_lastNotif');
    if (last === id) return;
    await SecureStore.setItemAsync('fu_lastNotif', id);
    const d = resp.notification.request.content.data || {};
    if (d.type === 'update') { runUpdate(); return; }
    if (d.type === 'unlock') handleUnlock(d.machine, d.nonce, resp.actionIdentifier);
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
          name: 'Unlock requests', importance: Notifications.AndroidImportance.MAX, sound: 'default' });
      }
      try {
        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        setPushToken((await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data);
      } catch {}
      handleResponse(await Notifications.getLastNotificationResponseAsync());   // cold-start tap
      checkForUpdate(false);
    })();
    const recv = Notifications.addNotificationReceivedListener((n) => {
      if ((n.request.content.data || {}).type === 'cancel') Notifications.dismissAllNotificationsAsync();
    });
    const resp = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => { recv.remove(); resp.remove(); };
  }, []);

  // ---- ping each laptop for name + online status (homepage) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const l of laptops) {
        try {
          const res = await postTo(l, 'info', {});
          if (!alive) return;
          if (res.ok) {
            const j = JSON.parse(await res.text());
            setStatus((s) => ({ ...s, [l.id]: { online: true, machine: j.machine, user: j.user } }));
          } else setStatus((s) => ({ ...s, [l.id]: { online: false } }));
        } catch { if (alive) setStatus((s) => ({ ...s, [l.id]: { online: false } })); }
      }
    })();
    return () => { alive = false; };
  }, [laptops, screen]);

  // ---- edit flow ----
  const isDirty = () => draft && orig && JSON.stringify(draft) !== JSON.stringify(orig);
  function openEdit(lap) {
    const d = lap || { id: String(Date.now()), name: '', ip: '', token: '', machine: '' };
    setDraft(d); setOrig(lap || d); setScreen('edit');
  }
  async function commitDraft() {
    const list = await loadLaptops();
    const i = list.findIndex((l) => l.id === draft.id);
    if (i >= 0) list[i] = draft; else list.push(draft);
    await saveLaptops(list); await refresh();
    setDraft(null); setOrig(null); setScreen('settings');
  }
  function leaveEdit() {
    if (draft && orig && draft !== orig && isDirty()) {
      Alert.alert('Save changes?', '', [
        { text: 'Discard', style: 'destructive', onPress: () => { setDraft(null); setScreen('settings'); } },
        { text: 'Save', onPress: commitDraft },
      ], { cancelable: true, onDismiss: () => { setDraft(null); setScreen('settings'); } });   // dismiss = discard
    } else { setDraft(null); setScreen('settings'); }
  }
  async function detect() {
    try {
      const res = await postTo(draft, 'info', {});
      if (res.ok) { const j = JSON.parse(await res.text());
        setDraft((d) => ({ ...d, machine: j.machine, name: d.name || j.machine })); }
      else Alert.alert('Detect', `Failed (${res.status}) — check IP/token`);
    } catch (e) { Alert.alert('Detect', e.message); }
  }
  async function pairDraft() {
    try { const res = await postTo(draft, 'register', { pushToken });
      Alert.alert('Pair', res.ok ? '✅ Paired' : `Failed (${res.status})`); }
    catch (e) { Alert.alert('Pair', e.message); }
  }
  async function removeLaptop(id) {
    const list = (await loadLaptops()).filter((l) => l.id !== id);
    await saveLaptops(list); await refresh();
  }

  // hardware back button
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'edit') { leaveEdit(); return true; }
      if (screen === 'settings') { setScreen('home'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [screen, draft, orig]);

  // ================= RENDER =================
  if (screen === 'edit' && draft) {
    return (
      <ScrollView contentContainerStyle={styles.c}>
        <Text style={styles.h}>{orig?.name || orig?.machine ? 'Edit laptop' : 'Add laptop'}</Text>

        <Text style={styles.label}>Name (optional)</Text>
        <TextInput style={styles.input} value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} placeholder="My laptop" placeholderTextColor="#889" />

        <Text style={styles.label}>Laptop IP</Text>
        <TextInput style={styles.input} value={draft.ip} onChangeText={(v) => setDraft({ ...draft, ip: v })}
          autoCapitalize="none" keyboardType="numbers-and-punctuation" placeholder="192.168.x.x or Tailscale IP" placeholderTextColor="#889" />

        <Text style={styles.label}>Token</Text>
        <TextInput style={styles.input} value={draft.token} onChangeText={(v) => setDraft({ ...draft, token: v })}
          autoCapitalize="none" secureTextEntry placeholder="same as service.ini" placeholderTextColor="#889" />

        {draft.machine ? <Text style={styles.detected}>Detected: {draft.machine}</Text> : null}

        <TouchableOpacity style={styles.btnAlt} onPress={detect}><Text style={styles.btnAltText}>Detect PC name</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnAlt} onPress={pairDraft}><Text style={styles.btnAltText}>Pair this phone</Text></TouchableOpacity>

        <TouchableOpacity style={styles.btn} onPress={commitDraft}><Text style={styles.btnText}>Save changes</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnGhost} onPress={leaveEdit}><Text style={styles.btnGhostText}>Back</Text></TouchableOpacity>
      </ScrollView>
    );
  }

  if (screen === 'settings') {
    return (
      <ScrollView contentContainerStyle={styles.c}>
        <Text style={styles.h}>⚙ Settings</Text>
        {laptops.length === 0 ? <Text style={styles.dim}>No laptops yet.</Text> : null}
        {laptops.map((l) => (
          <View key={l.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowName}>{l.name || l.machine || l.ip}</Text>
              <Text style={styles.dim}>{l.ip}</Text>
            </View>
            <TouchableOpacity onPress={() => openEdit(l)}><Text style={styles.icon}>✏️</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => Alert.alert('Remove', l.name || l.ip, [{ text: 'Cancel' }, { text: 'Remove', style: 'destructive', onPress: () => removeLaptop(l.id) }])}>
              <Text style={styles.icon}>🗑️</Text></TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity style={styles.btn} onPress={() => openEdit(null)}><Text style={styles.btnText}>+ Add laptop</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnAlt} onPress={() => Linking.openURL(TAILSCALE_PLAY)}><Text style={styles.btnAltText}>Install Tailscale (internet unlock)</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnAlt} onPress={() => checkForUpdate(true)}><Text style={styles.btnAltText}>Check for update</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnGhost} onPress={() => setScreen('home')}><Text style={styles.btnGhostText}>Back</Text></TouchableOpacity>
      </ScrollView>
    );
  }

  // HOME
  return (
    <ScrollView contentContainerStyle={styles.c}>
      <View style={styles.topbar}>
        <Text style={styles.title}>🔓 FingerUnlock</Text>
        <TouchableOpacity onPress={() => setScreen('settings')}><Text style={styles.gear}>⚙</Text></TouchableOpacity>
      </View>

      {laptops.length === 0 ? (
        <TouchableOpacity style={styles.btn} onPress={() => setScreen('settings')}>
          <Text style={styles.btnText}>+ Add your first laptop</Text>
        </TouchableOpacity>
      ) : laptops.map((l) => {
        const st = status[l.id] || {};
        return (
          <TouchableOpacity key={l.id} style={styles.card} onPress={() => unlockNow(l)}>
            <View style={[styles.dot, { backgroundColor: st.online ? '#37d67a' : '#666' }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{l.name || st.machine || l.machine || l.ip}</Text>
              <Text style={styles.dim}>{st.machine || l.machine || ''}{st.user ? ` · ${st.user}` : ''}</Text>
              <Text style={styles.dim}>{st.online ? 'connected · tap to unlock' : 'offline'}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  c: { backgroundColor: '#0f1220', padding: 22, paddingTop: 56, flexGrow: 1 },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700' },
  gear: { color: '#9ab6ff', fontSize: 26 },
  h: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 14 },
  label: { color: '#aab', fontSize: 13, marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: '#1b2030', color: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  detected: { color: '#37d67a', fontSize: 13, marginTop: 10 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1b2030', borderRadius: 12, padding: 16, marginBottom: 12 },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  cardName: { color: '#fff', fontSize: 18, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1b2030', borderRadius: 12, padding: 14, marginBottom: 10 },
  rowName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  icon: { fontSize: 20, marginLeft: 14 },
  dim: { color: '#889', fontSize: 13, marginTop: 2 },
  btn: { backgroundColor: '#3b6ef5', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 18 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnAlt: { borderColor: '#3b6ef5', borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  btnAltText: { color: '#9ab6ff', fontSize: 14, fontWeight: '600' },
  btnGhost: { paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  btnGhostText: { color: '#889', fontSize: 15 },
});
