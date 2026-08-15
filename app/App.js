import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, StatusBar,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

// FingerUnlock — Phase 2b app.
// Fingerprint gate -> POST /unlock (with token header) to the laptop service.
export default function App() {
  const [ip, setIp] = useState('192.168.1.50');   // <- set to your laptop VM's LAN IP
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const PORT = '5599';

  async function unlock() {
    try {
      setBusy(true);
      setStatus('');

      // 1) Fingerprint gate on the phone
      const hasHw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (hasHw && enrolled) {
        const r = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock your laptop',
          disableDeviceFallback: false,
        });
        if (!r.success) { setStatus('Fingerprint cancelled'); return; }
      } else {
        setStatus('No fingerprint enrolled — sending anyway (test).');
      }

      // 2) Send the unlock request
      const res = await fetch(`http://${ip}:${PORT}/unlock`, {
        method: 'POST',
        headers: { 'X-Token': token },
      });
      const body = await res.text();
      setStatus(res.ok ? '✅ Laptop unlocked!' : `❌ ${res.status}: ${body}`);
    } catch (e) {
      setStatus('❌ ' + e.message + '\n(Same WiFi? Correct IP? Firewall open?)');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.c}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>🔓 FingerUnlock</Text>

      <Text style={styles.label}>Laptop IP</Text>
      <TextInput
        style={styles.input} value={ip} onChangeText={setIp}
        autoCapitalize="none" keyboardType="numbers-and-punctuation"
        placeholder="192.168.x.x" placeholderTextColor="#889"
      />

      <Text style={styles.label}>Token</Text>
      <TextInput
        style={styles.input} value={token} onChangeText={setToken}
        autoCapitalize="none" secureTextEntry
        placeholder="same as service.ini" placeholderTextColor="#889"
      />

      <TouchableOpacity style={[styles.btn, busy && styles.btnBusy]} onPress={unlock} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Unlock Laptop</Text>}
      </TouchableOpacity>

      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: '#0f1220', padding: 24, justifyContent: 'center' },
  title: { color: '#fff', fontSize: 32, fontWeight: '700', marginBottom: 32, textAlign: 'center' },
  label: { color: '#aab', fontSize: 13, marginBottom: 6, marginTop: 14 },
  input: {
    backgroundColor: '#1b2030', color: '#fff', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
  },
  btn: {
    backgroundColor: '#3b6ef5', borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginTop: 28,
  },
  btnBusy: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  status: { color: '#cdd', fontSize: 15, textAlign: 'center', marginTop: 22, minHeight: 40 },
});
