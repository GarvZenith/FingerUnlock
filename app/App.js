import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, StatusBar, Alert, ScrollView
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';

// Configure notification presentation when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const [ip, setIp] = useState('192.168.1.50');
  const [token, setToken] = useState('changeme');
  const [pushToken, setPushToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [updateStatus, setUpdateStatus] = useState('');

  const notificationListener = useRef();
  const responseListener = useRef();
  const PORT = '5599';

  useEffect(() => {
    // 1) Setup Push Notification Listeners & Categories
    setupNotifications();

    // 2) Check for auto-updates (Loop-Safe)
    checkForUpdatesSafe();

    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, [ip, token]);

  // Safe update checker to prevent infinite update loops
  async function checkForUpdatesSafe() {
    if (__DEV__) return; // Skip in dev mode
    try {
      setUpdateStatus('Checking for updates...');
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateStatus('Downloading update...');
        await Updates.fetchUpdateAsync();
        setUpdateStatus('Update ready! Restarting...');
        await Updates.reloadAsync();
      } else {
        setUpdateStatus('App is up to date.');
      }
    } catch (error) {
      setUpdateStatus('Update check skipped.');
    }
  }

  async function setupNotifications() {
    // Register notification category with Approve / Deny actions
    try {
      await Notifications.setNotificationCategoryAsync('unlock', [
        {
          identifier: 'approve',
          buttonTitle: '🔓 Approve (Fingerprint)',
          options: { opensAppToForeground: true, isAuthenticationRequired: true },
        },
        {
          identifier: 'deny',
          buttonTitle: '❌ Deny',
          options: { isDestructive: true },
        },
      ]);
    } catch (e) {
      console.log('Category error:', e);
    }

    // Response listener when user taps notification or action button
    responseListener.current = Notifications.addNotificationResponseReceivedListener(async (response) => {
      const actionId = response.actionIdentifier;
      const data = response.notification.request.content.data;

      if (data?.type === 'unlock' && data?.nonce) {
        if (actionId === 'deny') {
          await sendDeny(data.nonce);
        } else {
          // Default tap or approve action -> trigger fingerprint
          await handlePushUnlock(data.nonce);
        }
      }
    });
  }

  // Register push token with the laptop service
  async function registerPushToken() {
    try {
      setBusy(true);
      setStatus('Obtaining push token...');

      if (!Device.isDevice) {
        setStatus('⚠️ Push notifications require a physical device.');
        setBusy(false);
        return;
      }

      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        setStatus('❌ Notification permission denied.');
        setBusy(false);
        return;
      }

      const tokenData = await Notifications.getExpoPushTokenAsync();
      const pToken = tokenData.data;
      setPushToken(pToken);

      // Register with laptop service
      setStatus('Sending push token to laptop...');
      const res = await fetch(`http://${ip}:${PORT}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushToken: pToken }),
      });

      const text = await res.text();
      if (res.ok) {
        setStatus('✅ Phone paired with Laptop successfully!');
      } else {
        setStatus(`❌ Registration failed (${res.status}): ${text}`);
      }
    } catch (e) {
      setStatus(`❌ Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Handle biometric fingerprint prompt and send /approve to service
  async function handlePushUnlock(nonce) {
    try {
      setStatus('Prompting fingerprint...');
      const hasHw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();

      if (hasHw && enrolled) {
        const auth = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock your laptop',
          cancelLabel: 'Cancel',
          disableDeviceFallback: false,
        });

        if (!auth.success) {
          setStatus('❌ Fingerprint authentication cancelled.');
          await sendDeny(nonce);
          return;
        }
      }

      setStatus('Approving unlock request...');
      const res = await fetch(`http://${ip}:${PORT}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, nonce }),
      });

      const body = await res.text();
      if (res.ok) {
        setStatus('✅ Laptop unlocked successfully!');
      } else {
        setStatus(`❌ Approval rejected: ${body}`);
      }
    } catch (e) {
      setStatus(`❌ Unlock error: ${e.message}`);
    }
  }

  async function sendDeny(nonce) {
    try {
      await fetch(`http://${ip}:${PORT}/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, nonce }),
      });
      setStatus('User DENIED unlock request.');
    } catch (e) {
      console.log('Deny error:', e);
    }
  }

  // Manual fallback unlock
  async function manualUnlock() {
    try {
      setBusy(true);
      setStatus('Authenticating fingerprint...');

      const hasHw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (hasHw && enrolled) {
        const auth = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock Laptop',
          disableDeviceFallback: false,
        });
        if (!auth.success) {
          setStatus('Fingerprint cancelled');
          setBusy(false);
          return;
        }
      }

      setStatus('Sending manual unlock...');
      const res = await fetch(`http://${ip}:${PORT}/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': token,
        },
        body: JSON.stringify({ token }),
      });

      const body = await res.text();
      setStatus(res.ok ? '✅ Laptop unlocked!' : `❌ ${res.status}: ${body}`);
    } catch (e) {
      setStatus('❌ ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>🔓 FingerUnlock</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Laptop IP Address</Text>
        <TextInput
          style={styles.input}
          value={ip}
          onChangeText={setIp}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          placeholder="192.168.x.x"
          placeholderTextColor="#889"
        />

        <Text style={styles.label}>Secret Token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          secureTextEntry
          placeholder="token from service.ini"
          placeholderTextColor="#889"
        />

        <TouchableOpacity
          style={[styles.btn, styles.btnPair, busy && styles.btnBusy]}
          onPress={registerPushToken}
          disabled={busy}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Pair Phone (Push Token)</Text>}
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.btn, styles.btnUnlock, busy && styles.btnBusy]}
        onPress={manualUnlock}
        disabled={busy}
      >
        <Text style={styles.btnText}>Manual Unlock Test</Text>
      </TouchableOpacity>

      <View style={styles.statusCard}>
        <Text style={styles.statusTitle}>Status Log</Text>
        <Text style={styles.status}>{status}</Text>
        {pushToken ? (
          <Text style={styles.tokenText}>Token: {pushToken.slice(0, 22)}...</Text>
        ) : null}
        {updateStatus ? <Text style={styles.updateText}>{updateStatus}</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#0f1220', padding: 24, justifyContent: 'center' },
  title: { color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 24, textAlign: 'center' },
  card: { backgroundColor: '#161b2e', padding: 18, borderRadius: 16, marginBottom: 16 },
  label: { color: '#aab', fontSize: 13, marginBottom: 6, marginTop: 10 },
  input: {
    backgroundColor: '#1b2030', color: '#fff', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
  },
  btn: {
    borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginTop: 16,
  },
  btnPair: { backgroundColor: '#2563eb' },
  btnUnlock: { backgroundColor: '#10b981' },
  btnBusy: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  statusCard: { backgroundColor: '#161b2e', padding: 16, borderRadius: 14, marginTop: 12 },
  statusTitle: { color: '#889', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 6 },
  status: { color: '#cdd', fontSize: 15, textAlign: 'center', minHeight: 30 },
  tokenText: { color: '#10b981', fontSize: 11, textAlign: 'center', marginTop: 8 },
  updateText: { color: '#aab', fontSize: 12, textAlign: 'center', marginTop: 6, fontStyle: 'italic' },
});
