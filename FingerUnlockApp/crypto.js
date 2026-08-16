// Stage 2 — phone-vault ECDH (pure JS, OTA-friendly).
// Pairs with the Windows service's Crypto.cs. All randomness comes from
// expo-crypto (native, in the build); @noble does the pure-math ECDH/HKDF/GCM,
// so we never touch globalThis.crypto (absent in Hermes).
import { p256 } from '@noble/curves/p256';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import * as Crypto from 'expo-crypto';

const INFO = utf8ToBytes('FingerUnlock-v1');

// A P-256 keypair. Private key is a random scalar in [1, n-1]; public key is the
// raw uncompressed point 04||X||Y (hex) that the PC pins at pairing.
export function genKeyPair() {
  const n = p256.CURVE.n;
  const rb = Crypto.getRandomBytes(32);
  let x = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(rb[i]);
  let k = x % n;
  if (k === 0n) k = 1n;
  const privHex = k.toString(16).padStart(64, '0');
  const pubHex = bytesToHex(p256.getPublicKey(hexToBytes(privHex), false)); // 04||X||Y
  return { privHex, pubHex };
}

// Encrypt the Windows password for the PC.
//   sharedX = ECDH(phonePriv, pcPub).X
//   key     = HKDF-SHA256(sharedX, salt = nonce, info = "FingerUnlock-v1", 32)
//   blob    = AES-256-GCM(key, iv, password, aad = nonce)  -> ciphertext || tag
export function encryptPassword(pcPubHex, phonePrivHex, nonce, password) {
  const shared = p256.getSharedSecret(phonePrivHex, pcPubHex.toLowerCase()); // compressed point
  const sharedX = shared.slice(1); // drop 0x02/0x03 prefix -> 32-byte X
  const nonceB = utf8ToBytes(nonce);
  const key = hkdf(sha256, sharedX, nonceB, INFO, 32);
  const iv = Crypto.getRandomBytes(12);
  const ct = gcm(key, iv, nonceB).encrypt(utf8ToBytes(password)); // ct||tag
  return { ivHex: bytesToHex(iv), ctHex: bytesToHex(ct) };
}
