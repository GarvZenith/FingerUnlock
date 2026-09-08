import { useEffect, useRef, useState, Component } from 'react';
import {
  Text, View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Platform, Linking, Alert, BackHandler, ToastAndroid,
  Vibration, Animated, Easing, Modal,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import messaging from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import { genKeyPair, encryptPassword } from './crypto';
import { showStickyNotification } from './fullscreen';

const PORT = '5599';
const DEFAULT_RELAY_URL = 'http://localhost:5590';
const TAILSCALE_PLAY = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
    }),
  });
} catch (e) {
  console.log('Notification handler set error:', e);
}

// ---- storage (module-level so the cold-start handler can use it) ----
async function loadLaptops() {
  try { const s = await SecureStore.getItemAsync('fu_laptops'); return s ? JSON.parse(s) : []; }
  catch { return []; }
}
async function saveLaptops(list) {
  await SecureStore.setItemAsync('fu_laptops', JSON.stringify(list));
  if (Platform.OS === 'android') {
    try {
      const NativeModules = require('react-native').NativeModules;
      if (NativeModules.SharedPreferences) {
        NativeModules.SharedPreferences.setItem('laptops_json', JSON.stringify(list || []));
        if (list && list.length > 0) {
          const l = list[0];
          NativeModules.SharedPreferences.setItem('deviceId', l.deviceId || '');
          NativeModules.SharedPreferences.setItem('ip', l.ip || '');
          NativeModules.SharedPreferences.setItem('tailscaleIp', l.tailscaleIp || '');
          NativeModules.SharedPreferences.setItem('relayUrl', l.relayUrl || DEFAULT_RELAY_URL);
          NativeModules.SharedPreferences.setItem('token', l.token || '');
        }
      }
    } catch (e) {}
  }
}

// Parallel Transport Racing Manager (LAN, Hotspot, Relay Server, Tailscale)
async function postTo(l, path, extra = {}, timeoutMs = 4000) {
  if (!l) throw new Error('No laptop configuration provided');

  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const payload = { ...extra, token: l.token || '', deviceId: l.deviceId || '', requestId };

  const endpoints = [];

  // 1. Direct Local LAN Endpoint
  if (l.ip) {
    endpoints.push({ type: 'lan', url: `http://${l.ip}:${PORT}/${path}` });
  }

  // 2. Phone Hotspot Gateways
  endpoints.push({ type: 'hotspot', url: `http://192.168.43.1:${PORT}/${path}` });
  endpoints.push({ type: 'hotspot', url: `http://192.168.49.1:${PORT}/${path}` });

  // 3. Tailscale Legacy Fallback Endpoint
  if (l.tailscaleIp && l.tailscaleIp !== l.ip) {
    endpoints.push({ type: 'tailscale', url: `http://${l.tailscaleIp}:${PORT}/${path}` });
  }

  // 4. Self-Hosted Secure Relay Endpoint
  const relayBaseUrl = l.relayUrl || DEFAULT_RELAY_URL;
  endpoints.push({ type: 'relay', url: `${relayBaseUrl}/${path}` });

  // Deduplicate endpoints by URL
  const uniqueEndpoints = [];
  const seen = new Set();
  for (const ep of endpoints) {
    if (!seen.has(ep.url)) {
      seen.add(ep.url);
      uniqueEndpoints.push(ep);
    }
  }

  return new Promise((resolve, reject) => {
    let completed = 0;
    let resolved = false;
    const errors = [];

    uniqueEndpoints.forEach((ep) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': l.token || '' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
        .then((res) => {
          clearTimeout(t);
          if (res.ok && !resolved) {
            resolved = true;
            resolve(res);
          } else if (!resolved) {
            completed++;
            if (completed === uniqueEndpoints.length) {
              reject(new Error(`All transports failed (${res.status})`));
            }
          }
        })
        .catch((err) => {
          clearTimeout(t);
          errors.push(err);
          completed++;
          if (completed === uniqueEndpoints.length && !resolved) {
            reject(errors[0] || new Error('Connection failed on all transports'));
          }
        });
    });
  });
}

// Fast Reachability Validation for Offline Biometric Guard
async function isLaptopReachable(l) {
  if (!l) return false;
  try {
    const res = await postTo(l, 'info', {}, 1800);
    return res.ok;
  } catch (e) {
    // If local/direct pings fail, check self-hosted relay presence endpoint
    if (l.deviceId) {
      try {
        const relayBaseUrl = l.relayUrl || DEFAULT_RELAY_URL;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(`${relayBaseUrl}/status/${l.deviceId}`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json();
          return !!j.online;
        }
      } catch (e2) {}
    }
    return false;
  }
}

function App() {
  const [screen, setScreen] = useState('home');    // home | settings | edit
  const [laptops, setLaptops] = useState([]);
  const [pushToken, setPushToken] = useState('');
  const [draft, setDraft] = useState(null);         // laptop being edited
  const [orig, setOrig] = useState(null);           // original (to detect changes)
  const [status, setStatus] = useState({});         // machine/online per laptop id
  const [tick, setTick] = useState(0);              // drives periodic online re-poll
  const [incoming, setIncoming] = useState(null);   // {machine, nonce} while the call-style screen rings
  const [qrInput, setQrInput] = useState('');       // QR JSON paste string
  const [showAdvanced, setShowAdvanced] = useState(false);  // Collapsible drawer toggle
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const ring = useRef(new Animated.Value(0)).current;
  const fcmRef = useRef('');                          // FCM device token (native full-screen path)

  const autoUnlockedRef = useRef(false);

  const refresh = async () => {
    const list = await loadLaptops();
    setLaptops(list);
    if (list && list.length > 0) {
      await saveLaptops(list);
    }
    return list;
  };

  useEffect(() => { refresh(); }, []);

  // Re-check each PC every 3s so a card flips offline->online on its own
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

    // Offline Biometric Guard
    const reachable = await isLaptopReachable(lap);
    if (!reachable) {
      ToastAndroid.show('PC is Offline — Cannot Unlock', ToastAndroid.SHORT);
      return;
    }

    const r = await LocalAuthentication.authenticateAsync({ promptMessage: `Unlock ${lap.name || lap.machine || 'laptop'}` });
    if (!r.success) return;
    let extra = { nonce };
    if (lap.pcPub && lap.priv && lap.pw) {
      try { const { ivHex, ctHex } = encryptPassword(lap.pcPub, lap.priv, nonce, lap.pw); extra = { nonce, iv: ivHex, ct: ctHex }; } catch {}
    }
    try { await postTo(lap, 'approve', extra); } catch {}
    await Notifications.dismissAllNotificationsAsync();
  }

  // Tap a laptop card -> fingerprint -> unlock on demand (uses the token-only /unlock).
  async function unlockNow(l) {
    if (!l) return;

    // Offline Biometric Guard: Check reachability before opening biometric prompt!
    const reachable = await isLaptopReachable(l);
    if (!reachable) {
      ToastAndroid.show('PC is Offline — Cannot Unlock', ToastAndroid.SHORT);
      return;
    }

    const r = await LocalAuthentication.authenticateAsync({ promptMessage: `Unlock ${l.name || l.machine || 'laptop'}` });
    if (!r.success) return;

    try {
      let res;
      if (l.pcPub && l.priv && l.pw) {
        const cr = await postTo(l, 'challenge', {}, 3000);
        if (!cr.ok) throw new Error(`challenge ${cr.status}`);
        const { nonce } = JSON.parse(await cr.text());
        const { ivHex, ctHex } = encryptPassword(l.pcPub, l.priv, nonce, l.pw);
        res = await postTo(l, 'approve', { nonce, iv: ivHex, ct: ctHex }, 3000);
      } else {
        res = await postTo(l, 'unlock', {}, 3000);   // fallback: token-only
      }
      ToastAndroid.show(res.ok ? `Unlock sent to ${l.name || l.machine || l.ip}` : `Failed (${res.status})`, ToastAndroid.SHORT);
    } catch (e) { ToastAndroid.show('Failed: ' + e.message, ToastAndroid.SHORT); }
  }

  function dropCall() { try { notifee.cancelAllNotifications(); } catch {} }
  async function showIncoming(machine, nonce) {
    dropCall();
    await handleUnlock(machine, nonce, 'yes');
  }
  function closeIncoming() { dropCall(); }

  // Register this phone's FCM token with every paired laptop
  async function registerFcmAll(list) {
    try {
      const tok = fcmRef.current || (await messaging().getToken());
      fcmRef.current = tok;
      for (const l of (list || (await loadLaptops()))) {
        try { await postTo(l, 'registerfcm', { fcmToken: tok }); } catch {}
      }
    } catch {}
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
    if (!resp) return false;
    const content = resp.notification?.request?.content;
    let d = content?.data || {};
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch {}
    }
    const date = resp.notification?.date;
    if (date && Date.now() - date > 45000) {
      return false;
    }
    const machine = d.machine || 'PC';
    const nonce = d.nonce || '';
    if (resp.actionIdentifier === 'yes' || resp.actionIdentifier === 'default' || !resp.actionIdentifier) {
      await handleUnlock(machine, nonce, 'yes');
      return true;
    } else if (resp.actionIdentifier === 'no') {
      await handleUnlock(machine, nonce, 'no');
      return true;
    } else if (d.type === 'unlock') {
      await handleUnlock(machine, nonce, 'yes');
      return true;
    }
    return false;
  }

  useEffect(() => {
    (async () => {
      const list = await refresh();

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
          name: 'Unlock requests',
          importance: Notifications.AndroidImportance.MAX,
          sound: 'default',
          vibrationPattern: [0, 500, 500, 500],
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
          bypassDnd: true,
          showBadge: true,
        });
        await Notifications.setNotificationChannelAsync('unlock_call_v3', {
          name: 'Incoming Unlock Calls',
          importance: Notifications.AndroidImportance.MAX,
          sound: 'default',
          vibrationPattern: [0, 500, 500, 500],
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
          bypassDnd: true,
          showBadge: true,
        });
      }
      try {
        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        setPushToken((await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data);
      } catch {}
      const lastResp = await Notifications.getLastNotificationResponseAsync();
      const handled = await handleResponse(lastResp);

      // Trigger automatic launch unlock if not handled by a fresh notification tap
      if (!handled && list && list.length > 0 && !autoUnlockedRef.current) {
        autoUnlockedRef.current = true;
        setTimeout(() => {
          unlockNow(list[0]);
        }, 350);
      }

      checkForUpdate(false);
    })();
    const recv = Notifications.addNotificationReceivedListener(async (n) => {
      const dd = n.request?.content?.data || {};
      if (dd.type === 'cancel') { Notifications.dismissAllNotificationsAsync(); closeIncoming(); }
      else if (dd.type === 'unlock') {
        showIncoming(dd.machine, dd.nonce);
        try { await showCall(dd); } catch {}
      }
    });
    const resp = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => { recv.remove(); resp.remove(); };
  }, []);

  // ---- FCM + Notifee ----
  useEffect(() => {
    let unMsg, unFg, unTok;
    (async () => {
      try {
        try { await messaging().requestPermission(); } catch {}
        await registerFcmAll();
        await showStickyNotification();
        try {
          const initial = await notifee.getInitialNotification();
          const d = initial?.notification?.data;
          if (d && d.type === 'unlock') showIncoming(d.machine, d.nonce);
        } catch {}

        try {
          unMsg = messaging().onMessage(async (m) => {
            const d = m.data || {};
            if (d.type === 'cancel') closeIncoming();
            else if (d.type === 'unlock') showIncoming(d.machine, d.nonce);
          });
        } catch (e) { console.log('FCM onMessage listener error:', e); }

        try {
          unFg = notifee.onForegroundEvent(({ type, detail }) => {
            if (type === EventType.PRESS || type === EventType.ACTION_PRESS) {
              const d = detail.notification?.data;
              if (d && d.type === 'unlock') showIncoming(d.machine, d.nonce);
            }
          });
        } catch (e) { console.log('Notifee onForegroundEvent listener error:', e); }

        try {
          unTok = messaging().onTokenRefresh(async (tok) => {
            fcmRef.current = tok;
            await registerFcmAll();
          });
        } catch {}
      } catch (e) { console.log('FCM/Notifee init error:', e); }
    })();
    return () => {
      try { if (unMsg) unMsg(); if (unFg) unFg(); if (unTok) unTok(); } catch {}
    };
  }, []);

  // ---- poll status ----
  useEffect(() => {
    if (laptops.length === 0) return;
    let cancelled = false;
    (async () => {
      const next = {};
      await Promise.all(laptops.map(async (l) => {
        try {
          const res = await postTo(l, 'info', {}, 2000);
          if (res.ok) {
            const j = JSON.parse(await res.text());
            next[l.id] = { online: true, machine: j.machine, user: j.user, locked: j.locked, paired: j.paired };
            if (j.machine && j.machine !== l.machine) {
              const updated = laptops.map((x) => x.id === l.id ? { ...x, machine: j.machine } : x);
              saveLaptops(updated); setLaptops(updated);
            }
          } else next[l.id] = { online: false };
        } catch { next[l.id] = { online: false }; }
      }));
      if (!cancelled) setStatus(next);
    })();
    return () => { cancelled = true; };
  }, [tick, laptops.length]);

  // ---- edit screen helpers ----
  async function startQrScan() {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert('Camera Permission Required', 'FingerUnlock requires camera permission to scan your laptop QR code.');
        return;
      }
    }
    setScanning(true);
  }

  function handleBarCodeScanned({ data }) {
    if (!data) return;
    try {
      const parsed = JSON.parse(data.trim());
      if (!parsed.deviceId && !parsed.ip) {
        throw new Error('Invalid pairing QR data format');
      }
      const newLap = {
        id: orig?.id || String(Date.now()),
        deviceId: parsed.deviceId || draft?.deviceId || '',
        name: parsed.name || draft?.name || 'Laptop',
        ip: parsed.ip || draft?.ip || '',
        tailscaleIp: parsed.tailscaleIp || draft?.tailscaleIp || '',
        relayUrl: parsed.relayUrl || draft?.relayUrl || DEFAULT_RELAY_URL,
        token: parsed.token || draft?.token || '',
        pw: draft?.pw || '',
        pcPub: parsed.pcPub || draft?.pcPub || ''
      };
      setScanning(false);
      (async () => {
        const list = await loadLaptops();
        const idx = list.findIndex((l) => (l.deviceId && l.deviceId === newLap.deviceId) || l.id === newLap.id);
        if (idx >= 0) list[idx] = newLap; else list.push(newLap);
        await saveLaptops(list);
        await refresh();
        registerFcmAll(list);
        ToastAndroid.show(`Paired successfully with ${newLap.name}!`, ToastAndroid.LONG);
        leaveEdit();
      })();
    } catch (e) {
      setScanning(false);
      Alert.alert('Invalid QR Code', 'The scanned QR code is not a valid FingerUnlock laptop pairing code.');
    }
  }

  function openEdit(lap) {
    setOrig(lap);
    setDraft(lap ? { ...lap } : { id: String(Date.now()), deviceId: '', name: '', ip: '', tailscaleIp: '', relayUrl: DEFAULT_RELAY_URL, token: '', pw: '' });
    setQrInput('');
    setShowAdvanced(false);
    setScreen('edit');
  }
  function leaveEdit() { setDraft(null); setOrig(null); setScreen(laptops.length === 0 ? 'settings' : 'home'); }
  async function commitDraft() {
    if (!draft.ip && !draft.deviceId) { Alert.alert('Missing field', 'Enter a laptop IP or Device ID'); return; }
    const list = await loadLaptops();
    const idx = list.findIndex((l) => l.id === draft.id);
    if (idx >= 0) list[idx] = draft; else list.push(draft);
    await saveLaptops(list);
    await refresh();
    registerFcmAll(list);
    leaveEdit();
  }
  async function detect() {
    if (!draft?.ip) { Alert.alert('Need IP', 'Enter the laptop IP first'); return; }
    try {
      const r = await postTo(draft, 'info', {});
      if (r.ok) {
        const j = JSON.parse(await r.text());
        setDraft({ ...draft, machine: j.machine || draft.machine, deviceId: j.deviceId || draft.deviceId });
        Alert.alert('Detected', `Machine: ${j.machine || 'OK'} (User: ${j.user || 'none'})`);
      } else Alert.alert('Failed', `HTTP ${r.status}`);
    } catch (e) { Alert.alert('Failed', e.message); }
  }
  async function pairDraft() {
    if (!draft?.ip) { Alert.alert('Need IP', 'Enter the laptop IP first'); return; }
    try {
      const { pubHex, privHex } = genKeyPair();
      const r = await postTo(draft, 'pair2', { phonePub: pubHex });
      if (!r.ok) { Alert.alert('Pair failed', `HTTP ${r.status}`); return; }
      const { pcPub, deviceId } = JSON.parse(await r.text());
      if (!pcPub) { Alert.alert('Pair failed', 'No public key returned'); return; }
      const updated = { ...draft, pcPub, priv: privHex, deviceId: deviceId || draft.deviceId };
      setDraft(updated);
      Alert.alert('Paired!', 'Hardened vault encryption enabled.');
    } catch (e) { Alert.alert('Pair error', e.message); }
  }

  function handleImportQr() {
    if (!qrInput || !qrInput.trim()) {
      Alert.alert('QR Error', 'Paste or enter valid QR pairing JSON data');
      return;
    }
    try {
      const data = JSON.parse(qrInput.trim());
      const updated = {
        id: orig?.id || String(Date.now()),
        deviceId: data.deviceId || draft.deviceId || '',
        name: data.name || draft.name || '',
        ip: data.ip || draft.ip || '',
        tailscaleIp: data.tailscaleIp || draft.tailscaleIp || '',
        relayUrl: data.relayUrl || draft.relayUrl || DEFAULT_RELAY_URL,
        token: data.token || draft.token || '',
        pw: draft.pw || '',
        pcPub: data.pcPub || draft.pcPub || ''
      };
      setDraft(updated);
      Alert.alert('QR Paired!', `Laptop "${updated.name || updated.deviceId}" configuration imported.`);
    } catch (e) {
      Alert.alert('Invalid QR JSON', e.message);
    }
  }

  function declineIncoming() {
    if (incoming?.nonce && laptops.length > 0) {
      handleUnlock(incoming.machine, incoming.nonce, 'no');
    }
    closeIncoming();
  }
  function acceptIncoming() {
    if (incoming?.nonce && laptops.length > 0) {
      handleUnlock(incoming.machine, incoming.nonce, 'yes');
    }
    closeIncoming();
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

        {/* PRIMARY HERO QR PAIRING CARD */}
        <View style={styles.qrHeroCard}>
          <Text style={styles.qrHeroTitle}>📷 Scan Laptop Screen QR</Text>
          <Text style={styles.qrHeroSub}>
            Run FingerUnlock on your Windows laptop with --pair-qr, then scan the laptop screen below to pair automatically.
          </Text>
          <TouchableOpacity style={styles.btnHeroScan} onPress={startQrScan} activeOpacity={0.85}>
            <Text style={styles.btnHeroScanTxt}>📷 Scan Laptop QR Code</Text>
          </TouchableOpacity>
        </View>

        {/* COLLAPSIBLE ADVANCED / MANUAL SETUP DRAWER */}
        <TouchableOpacity
          style={styles.advancedDrawerHeader}
          onPress={() => setShowAdvanced(!showAdvanced)}
          activeOpacity={0.8}
        >
          <Text style={styles.advancedDrawerTitle}>⚙ Advanced / Manual Setup</Text>
          <Text style={styles.advancedDrawerChevron}>{showAdvanced ? '▲ Collapse' : '▼ Expand'}</Text>
        </TouchableOpacity>

        {showAdvanced && (
          <View style={styles.advancedDrawerContent}>
            <Text style={styles.label}>Paste QR Data (Manual Fallback)</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <TextInput style={[styles.input, { flex: 1, marginRight: 8 }]} value={qrInput} onChangeText={setQrInput}
                autoCapitalize="none" placeholder='Paste QR JSON string' placeholderTextColor="#889" />
              <TouchableOpacity style={[styles.btnAlt, { marginTop: 0, paddingHorizontal: 12 }]} onPress={handleImportQr}>
                <Text style={styles.btnAltText}>Pair JSON</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Name (optional)</Text>
            <TextInput style={styles.input} value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} placeholder="My laptop" placeholderTextColor="#889" />

            <Text style={styles.label}>Device ID (Stable Identity)</Text>
            <TextInput style={styles.input} value={draft.deviceId || ''} onChangeText={(v) => setDraft({ ...draft, deviceId: v })}
              autoCapitalize="none" placeholder="FU-LAPTOP-XXXXXX" placeholderTextColor="#889" />

            <Text style={styles.label}>Laptop Local IP</Text>
            <TextInput style={styles.input} value={draft.ip} onChangeText={(v) => setDraft({ ...draft, ip: v })}
              autoCapitalize="none" keyboardType="numbers-and-punctuation" placeholder="192.168.x.x or Hotspot IP" placeholderTextColor="#889" />

            <Text style={styles.label}>Self-Hosted Relay Server URL</Text>
            <TextInput style={styles.input} value={draft.relayUrl || DEFAULT_RELAY_URL} onChangeText={(v) => setDraft({ ...draft, relayUrl: v })}
              autoCapitalize="none" placeholder="http://relay.yourdomain.com:5590" placeholderTextColor="#889" />

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

            <TouchableOpacity style={styles.btn} onPress={commitDraft}><Text style={styles.btnText}>Save manual changes</Text></TouchableOpacity>
          </View>
        )}

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
              <Text style={styles.rowName}>{l.name || l.machine || l.ip || l.deviceId}</Text>
              <Text style={styles.dim}>{l.ip || l.deviceId}</Text>
            </View>
            <TouchableOpacity onPress={() => openEdit(l)}><Text style={styles.icon}>✏️</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => Alert.alert('Remove', l.name || l.ip, [{ text: 'Cancel' }, { text: 'Remove', style: 'destructive', onPress: () => removeLaptop(l.id) }])}>
              <Text style={styles.icon}>🗑️</Text></TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity style={styles.btn} onPress={() => openEdit(null)}><Text style={styles.btnText}>+ Add laptop</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnAlt} onPress={() => Linking.openURL(TAILSCALE_PLAY)}><Text style={styles.btnAltText}>Install Tailscale (legacy path)</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnAlt} onPress={() => checkForUpdate(true)}><Text style={styles.btnAltText}>Check for update</Text></TouchableOpacity>
        <TouchableOpacity style={styles.btnGhost} onPress={() => setScreen('home')}><Text style={styles.btnGhostText}>Back</Text></TouchableOpacity>
      </ScrollView>
    );
  }

  // HOME
  return (
    <View style={{ flex: 1, backgroundColor: '#0f1220' }}>
      <ScrollView contentContainerStyle={styles.c}>
        <View style={styles.topbar}>
          <Text style={styles.title}>🔓 FingerUnlock</Text>
          <TouchableOpacity onPress={() => setScreen('settings')}><Text style={styles.gear}>⚙</Text></TouchableOpacity>
        </View>

        {laptops.length === 0 ? (
          <TouchableOpacity style={styles.btn} onPress={() => openEdit(null)}>
            <Text style={styles.btnText}>+ Add your first laptop</Text>
          </TouchableOpacity>
        ) : laptops.map((l) => {
          const st = status[l.id] || {};
          return (
            <TouchableOpacity key={l.id} style={styles.card} onPress={() => unlockNow(l)}>
              <View style={[styles.dot, { backgroundColor: st.online ? '#37d67a' : '#666' }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{l.name || st.machine || l.machine || l.ip || l.deviceId}</Text>
                <Text style={styles.dim}>{st.machine || l.machine || ''}{st.user ? ` · ${st.user}` : ''}</Text>
                <Text style={styles.dim}>{st.online ? 'connected · tap to unlock' : 'offline'}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* FULL SCREEN CAMERA PAIRING SCANNER MODAL */}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            onBarcodeScanned={handleBarCodeScanned}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          />
          <View style={styles.scannerOverlay}>
            <View style={styles.scannerHeader}>
              <Text style={styles.scannerTitle}>Scan Laptop Pairing QR</Text>
              <TouchableOpacity onPress={() => setScanning(false)} style={styles.scannerCloseBtn}>
                <Text style={styles.scannerCloseTxt}>✕ Close</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.scannerTargetBox} />
            <Text style={styles.scannerHint}>Align laptop screen QR code inside the frame</Text>
          </View>
        </View>
      </Modal>
    </View>
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
  btnAlt: { backgroundColor: '#252c40', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  btnAltText: { color: '#9ab6ff', fontSize: 14, fontWeight: '600' },
  btnGhost: { paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  btnGhostText: { color: '#889', fontSize: 15 },
  ringWrap: { flex: 1, backgroundColor: '#0b0d19', padding: 24, paddingTop: 60, justifyContent: 'space-between' },
  ringTop: { color: '#37d67a', fontSize: 13, fontWeight: '700', letterSpacing: 1.5, textAlign: 'center' },
  ringCenter: { width: 140, height: 140, alignItems: 'center', justifyContent: 'center', marginVertical: 30 },
  halo: { position: 'absolute', width: 140, height: 140, borderRadius: 70, backgroundColor: '#3b6ef5' },
  avatar: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#1f2740', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#3b6ef5' },
  avatarTxt: { color: '#fff', fontSize: 36, fontWeight: '700' },
  ringName: { color: '#fff', fontSize: 26, fontWeight: '700', marginTop: 12 },
  ringSub: { color: '#889', fontSize: 14, marginTop: 6 },
  ringHint: { color: '#37d67a', fontSize: 14, fontWeight: '600', marginTop: 18 },
  ringBottom: { marginBottom: 30 },
  ringBtns: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  ringBtn: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  decline: { backgroundColor: '#e53935' },
  accept: { backgroundColor: '#43a047' },
  ringBtnIcon: { color: '#fff', fontSize: 30, fontWeight: '700' },
  ringLabels: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10 },
  ringLbl: { color: '#aab', fontSize: 13 },
  qrHeroCard: { backgroundColor: '#1b2030', borderRadius: 16, padding: 20, marginBottom: 20, borderWidth: 1, borderColor: '#3b6ef5' },
  qrHeroTitle: { color: '#37d67a', fontSize: 18, fontWeight: '700', marginBottom: 6 },
  qrHeroSub: { color: '#aab', fontSize: 13, lineHeight: 18, marginBottom: 16 },
  btnHeroScan: { backgroundColor: '#3b6ef5', borderRadius: 12, paddingVertical: 14, alignItems: 'center', shadowColor: '#3b6ef5', shadowOpacity: 0.4, shadowRadius: 8, elevation: 4 },
  btnHeroScanTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  advancedDrawerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#181d2c', borderRadius: 10, padding: 14, marginBottom: 12 },
  advancedDrawerTitle: { color: '#9ab6ff', fontSize: 15, fontWeight: '600' },
  advancedDrawerChevron: { color: '#889', fontSize: 13, fontWeight: '600' },
  advancedDrawerContent: { backgroundColor: '#141824', borderRadius: 12, padding: 14, marginBottom: 16 },
  scannerOverlay: { flex: 1, justifyContent: 'space-between', alignItems: 'center', paddingVertical: 50, paddingHorizontal: 20, backgroundColor: 'rgba(0,0,0,0.5)' },
  scannerHeader: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scannerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  scannerCloseBtn: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  scannerCloseTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
  scannerTargetBox: { width: 260, height: 260, borderWidth: 3, borderColor: '#37d67a', borderRadius: 24, backgroundColor: 'transparent' },
  scannerHint: { color: '#fff', fontSize: 14, fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12 },
});

export default App;
