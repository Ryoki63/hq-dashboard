// dashboard/crypto.js — 暗号化ダッシュボードの復号（ブラウザ / Node 共通）
//
// 形式（ARCHITECTURE §9）:
//   {"v":1,"kdf":"PBKDF2-SHA256","iter":600000,
//    "salt":b64(16B),"iv":b64(12B),"ct":b64(ciphertext||tag16)}
// AES-256-GCM、AAD なし。平文は UTF-8 の JSON。
//
// ブラウザでも Node でも `globalThis.crypto.subtle` を使う。
// 暗号化（書き出し）はここには置かない。テスト側の小さなヘルパーで作る。

export const ENVELOPE_VERSION = 1;
export const KDF_NAME = 'PBKDF2-SHA256';
export const DEFAULT_ITERATIONS = 600000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const KEY_BITS = 256;
export const TAG_BYTES = 16;

/** 復号できなかった理由を持つエラー。 */
export class DecryptionError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'DecryptionError';
    this.code = code;
  }
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new DecryptionError('crypto-unavailable', 'WebCrypto が利用できません');
  }
  return c.subtle;
}

/**
 * base64 → Uint8Array。不正な文字列は DecryptionError('invalid-format')。
 * パディング有無の両方を受け付ける。
 */
export function base64ToBytes(value) {
  if (typeof value !== 'string') {
    throw new DecryptionError('invalid-format', 'base64 が文字列ではありません');
  }
  const normalized = value.replace(/\s+/g, '');
  if (normalized === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new DecryptionError('invalid-format', 'base64 の形式が不正です');
  }
  let binary;
  if (typeof globalThis.atob === 'function') {
    try {
      binary = globalThis.atob(normalized);
    } catch {
      throw new DecryptionError('invalid-format', 'base64 を復号できません');
    }
  } else if (typeof globalThis.Buffer !== 'undefined') {
    binary = globalThis.Buffer.from(normalized, 'base64').toString('binary');
  } else {
    throw new DecryptionError('crypto-unavailable', 'base64 デコーダがありません');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Uint8Array → base64（テストや補助用）。 */
export function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Uint8Array を渡してください');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(bytes).toString('base64');
  }
  throw new DecryptionError('crypto-unavailable', 'base64 エンコーダがありません');
}

/**
 * 封筒の形を検証する。問題があれば DecryptionError('invalid-format')。
 * 正常時は {iter, salt, iv, ct} を返す。
 */
export function parseEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new DecryptionError('invalid-format', '暗号データの形式が不正です');
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new DecryptionError('invalid-format', `未対応のバージョンです: ${String(envelope.v)}`);
  }
  if (envelope.kdf !== KDF_NAME) {
    throw new DecryptionError('invalid-format', `未対応の KDF です: ${String(envelope.kdf)}`);
  }
  const iter = envelope.iter;
  if (!Number.isInteger(iter) || iter <= 0 || iter > 10_000_000) {
    throw new DecryptionError('invalid-format', 'iter が不正です');
  }
  const salt = base64ToBytes(envelope.salt);
  if (salt.length !== SALT_BYTES) {
    throw new DecryptionError('invalid-format', `salt は ${SALT_BYTES} バイトである必要があります`);
  }
  const iv = base64ToBytes(envelope.iv);
  if (iv.length !== IV_BYTES) {
    throw new DecryptionError('invalid-format', `iv は ${IV_BYTES} バイトである必要があります`);
  }
  const ct = base64ToBytes(envelope.ct);
  if (ct.length <= TAG_BYTES) {
    throw new DecryptionError('invalid-format', '暗号文が短すぎます');
  }
  return { iter, salt, iv, ct };
}

/** パスフレーズと salt から AES-256-GCM の鍵を作る（PBKDF2-SHA256）。 */
export async function deriveAesKey(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw new DecryptionError('bad-passphrase', 'パスフレーズが空です');
  }
  const crypto = subtle();
  const baseKey = await crypto.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['decrypt'],
  );
}

/**
 * 封筒を復号して JSON を返す。
 * 形が不正 → code 'invalid-format' / パスフレーズ違い → code 'bad-passphrase'。
 */
export async function decryptEnvelope(envelope, passphrase) {
  const { iter, salt, iv, ct } = parseEnvelope(envelope);
  const key = await deriveAesKey(passphrase, salt, iter);
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch {
    throw new DecryptionError('bad-passphrase', 'パスフレーズが違います');
  }
  let text;
  try {
    text = new TextDecoder('utf-8').decode(plain);
  } catch {
    throw new DecryptionError('invalid-format', '復号結果を文字列にできません');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DecryptionError('invalid-format', '復号結果が JSON ではありません');
  }
}
