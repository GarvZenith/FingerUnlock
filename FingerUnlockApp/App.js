import { useEffect, useRef, useState } from 'react';
import {
  Text, View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Platform, Linking, Alert, BackHandler, ToastAndroid,
  Vibration, Animated, Easing,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { genKeyPair, encryptPassword } from './crypto';

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

async function postTo(l, path, extra, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`http://${l.ip}:${PORT}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extra, token: l.token }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
}

export default function App() {
  const [screen, setScreen] = useState('home');    // home | settings | edit
  const [laptops, setLaptops] = useState([]);
  const [pushToken, setPushToken] = useState('');
  const [draft, setDraft] = useState(null);         // laptop being edited
  const [orig, setOrig] = useState(null);           // original (to detect changes)
  const [status, setStatus] = useState({});         // machine/online per laptop id
  const [tick, setTick] = useState(0);              // drives periodic online re-poll
  const [incoming, setIncoming] = useState(null);   // {machine, nonce} while the call-style screen rings
  const ring = useRef(new Animated.Value(0)).current;

  const refresh = async () => setLaptops(await loadLaptops());
  useEffect(() => { refresh(); }, []);

  // Re-check each PC every 3s so a card flips offline->online on its own the
  // moment the PC is reachable again (e.g. after a reboot at the logon screen).
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(id);
  }, []);

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
    // If this laptop is set up for the encrypted vault, send the password blob;
    // otherwise fall back to the plain nonce approval (config.ini on the PC).
    let extra = { nonce };
    if (lap.pcPub && lap.priv && lap.pw) {
      try { const { ivHex, ctHex } = encryptPassword(lap.pcPub, lap.priv, nonce, lap.pw); extra = { nonce, iv: ivHex, ct: ctHex }; } catch {}
    }
    try { await postTo(lap, 'approve', extra); } catch {}
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
      let res;
      if (l.pcPub && l.priv && l.pw) {
        // hardened vault: fetch a nonce, send the encrypted password
        const cr = await postTo(l, 'challenge', {});
        if (!cr.ok) throw new Error(`challenge ${cr.status}`);
        const { nonce } = JSON.parse(await cr.text());
        const { ivHex, ctHex } = encryptPassword(l.pcPub, l.priv, nonce, l.pw);
        res = await postTo(l, 'approve', { nonce, iv: ivHex, ct: ctHex });
      } else {
        res = await postTo(l, 'unlock', {});   // fallback: token-only (PC uses config.ini)
      }
      ToastAndroid.show(res.ok ? `Unlock sent to ${l.name || l.machine || l.ip}` : `Failed (${res.status})`, ToastAndroid.SHORT);
    } catch (e) { ToastAndroid.show('Failed: ' + e.message, ToastAndroid.SHORT); }
  }

  // ---- call-style incoming screen ----
  function showIncoming(machine, nonce) { setIncoming({ machine, nonce }); setScreen('incoming'); }
  function closeIncoming() { Vibration.cancel(); setIncoming(null); setScreen((s) => (s === 'incoming' ? 'home' : s)); }
  async function acceptIncoming() {
    Vibration.cancel();
    const inc = incoming;
    if (inc) await handleUnlock(inc.machine, inc.nonce, 'yes');   // fingerprint -> encrypted approve
    setIncoming(null); setScreen('home');
  }
  async function declineIncoming() {
    Vibration.cancel();
    const inc = incoming;
    setIncoming(null); setScreen('home');
    if (inc) await handleUnlock(inc.machine, inc.nonce, 'no');
  }

  // Ring + vibrate while the incoming screen is up; auto-dismiss after 45s.
  useEffect(() => {
    if (screen !== 'incoming') return;
    Vibration.vibrate([0, 700, 900], true);
    ring.setValue(0);
    const anim = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: true }));
    anim.start();
    const to = setTimeout(() => closeIncoming(), 45000);
    return () => { anim.stop(); Vibration.cancel(); clearTimeout(to); };
  }, [screen]);

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
    if (d.type === 'unlock') {
      if (resp.actionIdentifier === 'yes') handleUnlock(d.machine, d.nonce, 'yes');       // quick action from the shade
      else if (resp.actionIdentifier === 'no') handleUnlock(d.machine, d.nonce, 'no');
      else showIncoming(d.machine, d.nonce);                                              // tapped the body -> ringing screen
    }
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
      const dd = n.request.content.data || {};
      if (dd.type === 'cancel') { Notifications.dismissAllNotificationsAsync(); closeIncoming(); }   // PC unlocked/cancelled -> stop ringing
      else if (dd.type === 'unlock') showIncoming(dd.machine, dd.nonce);                              // foreground -> ring immediately
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
          const res = await postTo(l, 'info', {}, 2500);
          if (!alive) return;
          if (res.ok) {
            const j = JSON.parse(await res.text());
            setStatus((s) => ({ ...s, [l.id]: { online: true, machine: j.machine, user: j.user } }));
          } else setStatus((s) => ({ ...s, [l.id]: { online: false } }));
        } catch { if (alive) setStatus((s) => ({ ...s, [l.id]: { online: false } })); }
      }
    })();
    return () => { alive = false; };
  }, [laptops, screen, tick]);

  // ---- edit flow ----
  const isDirty = () => draft && orig && JSON.stringify(draft) !== JSON.stringify(orig);
  function openEdit(lap) {
    const d = lap || { id: String(Date.now()), name: '', ip: '', token: '', machine: '', pw: '' };
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
    try {
      let d = draft;
      if (!d.priv || !d.pub) { const kp = genKeyPair(); d = { ...d, priv: kp.privHex, pub: kp.pubHex }; }
      await postTo(d, 'register', { pushToken });               // push token (existing)
      const res = await postTo(d, 'pair2', { phonePub: d.pub }); // ECDH key exchange (Stage 2)
      if (res.ok) { const j = JSON.parse(await res.text()); d = { ...d, pcPub: j.pcPub }; }
      setDraft(d);
      Alert.alert('Pair', res.ok ? '✅ Paired (push + encryption). Tap Save changes.' : `Push ok, key exchange failed (${res.status})`);
    } catch (e) { Alert.alert('Pair', e.message); }
  }
  async function removeLaptop(id) {
    const list = (await loadLaptops()).filter((l) => l.id !== id);
    await saveLaptops(list); await refresh();
  }

  // hardware back button
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'incoming') { declineIncoming(); return true; }
      if (screen === 'edit') { leaveEdit(); return true; }
      if (screen === 'settings') { setScreen('home'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [screen, draft, orig, incoming]);

  // ================= RENDER =================
  if (screen === 'incoming') {
    const inc = incoming || {};
    const lap = laptops.find((l) => l.machine && inc.machine && l.machine === inc.machine)
      || (laptops.length === 1 ? laptops[0] : null);
    const title = lap?.name || inc.machine || 'Laptop';
    const scale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.5] });
    const haloOpacity = ring.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] });
    return (
      <View style={styles.ringWrap}>
        <Text style={styles.ringTop}>UNLOCK REQUEST</Text>

        <View style={{ alignItems: 'center' }}>
          <View style={styles.ringCenter}>
            <Animated.View style={[styles.halo, { transform: [{ scale }], opacity: haloOpacity }]} />
            <View style={styles.avatar}><Text style={styles.avatarTxt}>{(title[0] || '💻').toUpperCase()}</Text></View>
          </View>
          <Text style={styles.ringName}>{title}</Text>
          <Text style={styles.ringSub}>wants to unlock{lap?.ip ? ` · ${lap.ip}` : ''}</Text>
          <Text style={styles.ringHint}>Accept and scan your fingerprint</Text>
        </View>

        <View style={styles.ringBottom}>
          <View style={styles.ringBtns}>
            <TouchableOpacity style={[styles.ringBtn, styles.decline]} onPress={declineIncoming} activeOpacity={0.8}>
              <Text style={styles.ringBtnIcon}>✕</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.ringBtn, styles.accept]} onPress={acceptIncoming} activeOpacity={0.8}>
              <Text style={styles.ringBtnIcon}>☝</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.ringLabels}>
            <Text style={styles.ringLbl}>Decline</Text>
            <Text style={styles.ringLbl}>Accept</Text>
          </View>
        </View>
      </View>
    );
  }

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

        <Text style={styles.label}>Windows password (stored only on this phone)</Text>
        <TextInput style={styles.input} value={draft.pw || ''} onChangeText={(v) => setDraft({ ...draft, pw: v })}
          autoCapitalize="none" secureTextEntry placeholder="for hardened / cold-boot login" placeholderTextColor="#889" />

        {draft.machine ? <Text style={styles.detected}>Detected: {draft.machine}</Text> : null}
        {draft.pcPub ? <Text style={styles.detected}>🔒 Encryption paired</Text> : null}

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

  // call-style incoming screen
  ringWrap: { flex: 1, backgroundColor: '#0b0e1a', alignItems: 'center', justifyContent: 'space-between', paddingTop: 84, paddingBottom: 56 },
  ringTop: { color: '#8aa0d0', fontSize: 14, letterSpacing: 3, fontWeight: '700' },
  ringCenter: { width: 240, height: 240, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: '#3b6ef5' },
  avatar: { width: 132, height: 132, borderRadius: 66, backgroundColor: '#151b30', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#3b6ef5' },
  avatarTxt: { color: '#cfe0ff', fontSize: 58, fontWeight: '700' },
  ringName: { color: '#fff', fontSize: 30, fontWeight: '700', marginTop: 14 },
  ringSub: { color: '#8892b0', fontSize: 15, marginTop: 8 },
  ringHint: { color: '#6b7699', fontSize: 13, marginTop: 4 },
  ringBottom: { width: 300 },
  ringBtns: { flexDirection: 'row', justifyContent: 'space-between' },
  ringBtn: { width: 82, height: 82, borderRadius: 41, alignItems: 'center', justifyContent: 'center' },
  decline: { backgroundColor: '#e5484d' },
  accept: { backgroundColor: '#30a46c' },
  ringBtnIcon: { fontSize: 34, color: '#fff' },
  ringLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  ringLbl: { color: '#99a', fontSize: 14, width: 82, textAlign: 'center' },
});
