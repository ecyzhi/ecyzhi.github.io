// JWT parsing and signature checks. Everything runs in the browser with WebCrypto.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface Part<T> {
  raw: string;
  value?: T;
  error?: string;
}

export interface Decoded {
  kind: 'jws' | 'jwe';
  header: Part<JsonObject>;
  payload: Part<JsonObject>;
  /** The payload as text when it isn't a JSON object (rare, but legal for JWS). */
  payloadText?: string;
  signature: string;
}

export type ParseResult = { ok: true; token: string; jwt: Decoded } | { ok: false; error: string };

const B64URL = /^[A-Za-z0-9_-]*$/;

export function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const s = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 1) throw new Error('Not valid base64url (bad length).');
  const bin = atob(pad ? s + '='.repeat(4 - pad) : s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeSegment(raw: string, name: string): { text?: string; error?: string } {
  if (!raw) return { error: `The ${name} is empty.` };
  if (!B64URL.test(raw)) return { error: `The ${name} has characters that aren't base64url.` };
  try {
    return { text: utf8.decode(base64UrlToBytes(raw)) };
  } catch {
    return { error: `The ${name} isn't valid base64url text.` };
  }
}

function jsonObject(text: string, name: string): { value?: JsonObject; error?: string } {
  try {
    const v = JSON.parse(text) as Json;
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v };
    return { error: `The ${name} decodes to JSON, but not to an object.` };
  } catch {
    return { error: `The ${name} isn't valid JSON.` };
  }
}

/** Strips whitespace, quotes and a leading "Bearer " so pasted headers work. */
export function cleanToken(input: string): string {
  let s = input.trim();
  s = s.replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '');
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  return s.replace(/\s+/g, '');
}

export function parseJwt(input: string): ParseResult {
  const token = cleanToken(input);
  if (!token) return { ok: false, error: '' };
  const parts = token.split('.');
  if (parts.length === 5) {
    const h = decodeSegment(parts[0], 'header');
    const header: Part<JsonObject> = { raw: parts[0], error: h.error };
    if (h.text !== undefined) Object.assign(header, jsonObject(h.text, 'header'));
    return {
      ok: true,
      token,
      jwt: {
        kind: 'jwe',
        header,
        payload: { raw: parts[3], error: 'This is an encrypted token (JWE). Its payload can only be read with the private key.' },
        signature: parts[4],
      },
    };
  }
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `A JWT has three parts separated by dots. This has ${parts.length === 1 ? 'no dots' : `${parts.length} parts`}.`,
    };
  }
  const [hRaw, pRaw, sRaw] = parts;
  const header: Part<JsonObject> = { raw: hRaw };
  const h = decodeSegment(hRaw, 'header');
  if (h.error) header.error = h.error;
  else Object.assign(header, jsonObject(h.text!, 'header'));

  const payload: Part<JsonObject> = { raw: pRaw };
  let payloadText: string | undefined;
  const p = decodeSegment(pRaw, 'payload');
  if (p.error) payload.error = p.error;
  else {
    const j = jsonObject(p.text!, 'payload');
    if (j.value) payload.value = j.value;
    else {
      payload.error = j.error;
      payloadText = p.text;
    }
  }
  const signature: string = sRaw;
  return { ok: true, token, jwt: { kind: 'jws', header, payload, payloadText, signature } };
}

// ---------- Time claims ----------

export type TimeStatus =
  | { state: 'none' }
  | { state: 'valid'; exp?: number }
  | { state: 'expired'; exp: number }
  | { state: 'early'; nbf: number };

export function timeStatus(payload: JsonObject | undefined, nowSec: number): TimeStatus {
  if (!payload) return { state: 'none' };
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  const nbf = typeof payload.nbf === 'number' ? payload.nbf : undefined;
  if (exp === undefined && nbf === undefined) return { state: 'none' };
  if (exp !== undefined && nowSec >= exp) return { state: 'expired', exp };
  if (nbf !== undefined && nowSec < nbf) return { state: 'early', nbf };
  return { state: 'valid', exp };
}

/** "2h 5m", "3d 4h", "42s". */
export function duration(seconds: number): string {
  let s = Math.max(0, Math.round(Math.abs(seconds)));
  const units: [string, number][] = [
    ['y', 31536000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const out: string[] = [];
  for (const [u, n] of units) {
    if (s >= n || (u === 's' && out.length === 0)) {
      out.push(`${Math.floor(s / n)}${u}`);
      s %= n;
    }
    if (out.length === 2) break;
  }
  return out.join(' ');
}

export function relative(sec: number, nowSec: number): string {
  const d = sec - nowSec;
  if (Math.abs(d) < 1) return 'now';
  return d > 0 ? `in ${duration(d)}` : `${duration(d)} ago`;
}

export const TIME_CLAIMS = new Set(['exp', 'nbf', 'iat', 'auth_time', 'updated_at']);

export const CLAIM_NAMES: Record<string, string> = {
  // Registered (RFC 7519)
  iss: 'Issuer',
  sub: 'Subject',
  aud: 'Audience',
  exp: 'Expires',
  nbf: 'Not before',
  iat: 'Issued at',
  jti: 'Token ID',
  // Common OpenID / OAuth
  azp: 'Authorized party',
  auth_time: 'Signed in at',
  nonce: 'Nonce',
  sid: 'Session ID',
  scope: 'Scopes',
  scp: 'Scopes',
  client_id: 'Client ID',
  name: 'Name',
  email: 'Email',
  email_verified: 'Email verified',
  roles: 'Roles',
  updated_at: 'Updated at',
  // Header
  alg: 'Algorithm',
  typ: 'Type',
  cty: 'Content type',
  kid: 'Key ID',
  jku: 'Key set URL',
  x5t: 'Cert thumbprint',
  enc: 'Encryption',
};

// ---------- Signatures ----------

type Hash = 'SHA-256' | 'SHA-384' | 'SHA-512';

interface AlgInfo {
  family: 'HS' | 'RS' | 'PS' | 'ES' | 'EdDSA';
  hash: Hash;
  curve?: 'P-256' | 'P-384' | 'P-521';
}

export function algInfo(alg: unknown): AlgInfo | null {
  if (typeof alg !== 'string') return null;
  if (alg === 'EdDSA' || alg === 'Ed25519') return { family: 'EdDSA', hash: 'SHA-512' };
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg);
  if (!m) return null;
  const bits = m[2] as '256' | '384' | '512';
  const hash = `SHA-${bits}` as Hash;
  const family = m[1] as AlgInfo['family'];
  if (family === 'ES') return { family, hash, curve: bits === '512' ? 'P-521' : (`P-${bits}` as 'P-256' | 'P-384') };
  return { family, hash };
}

export type VerifyResult = { state: 'valid' } | { state: 'invalid' } | { state: 'error'; message: string };

function pemBody(pem: string, label: string): Uint8Array<ArrayBuffer> | null {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const m = re.exec(pem);
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function importParams(info: AlgInfo): RsaHashedImportParams | EcKeyImportParams | Algorithm {
  switch (info.family) {
    case 'RS':
      return { name: 'RSASSA-PKCS1-v1_5', hash: info.hash };
    case 'PS':
      return { name: 'RSA-PSS', hash: info.hash };
    case 'ES':
      return { name: 'ECDSA', namedCurve: info.curve! };
    default:
      return { name: 'Ed25519' };
  }
}

function verifyParams(info: AlgInfo): Algorithm | RsaPssParams | EcdsaParams {
  switch (info.family) {
    case 'PS':
      return { name: 'RSA-PSS', saltLength: Number(info.hash.slice(4)) / 8 };
    case 'ES':
      return { name: 'ECDSA', hash: info.hash };
    case 'RS':
      return { name: 'RSASSA-PKCS1-v1_5' };
    default:
      return { name: 'Ed25519' };
  }
}

async function importPublicKey(text: string, info: AlgInfo, kid: unknown): Promise<CryptoKey> {
  const t = text.trim();
  const params = importParams(info);
  if (t.startsWith('{')) {
    let jwk: JsonWebKey & { kid?: string; keys?: (JsonWebKey & { kid?: string })[] };
    try {
      jwk = JSON.parse(t);
    } catch {
      throw new Error('The key looks like JSON but doesn’t parse.');
    }
    if (Array.isArray(jwk.keys)) {
      const keys = jwk.keys;
      const match = (typeof kid === 'string' && keys.find((k) => k.kid === kid)) || (keys.length === 1 ? keys[0] : undefined);
      if (!match) throw new Error(typeof kid === 'string' ? `No key with kid "${kid}" in this key set.` : 'The key set has several keys and the token has no kid. Paste just one key.');
      jwk = match;
    }
    // Drop hints that make importKey stricter than the token's own alg.
    const clean: Record<string, unknown> = { ...jwk };
    for (const k of ['alg', 'use', 'key_ops', 'keys']) delete clean[k];
    return crypto.subtle.importKey('jwk', clean as JsonWebKey, params, false, ['verify']);
  }
  if (/BEGIN CERTIFICATE/.test(t)) throw new Error('Certificates aren’t supported yet. Paste the public key (BEGIN PUBLIC KEY) or a JWK instead.');
  if (/BEGIN RSA PUBLIC KEY/.test(t)) throw new Error('This is a PKCS#1 key. Convert it to a BEGIN PUBLIC KEY (SPKI) key, or paste a JWK.');
  if (/PRIVATE KEY/.test(t)) throw new Error('That’s a private key. Paste the public key; never share the private one.');
  const der = pemBody(t, 'PUBLIC KEY');
  if (!der) throw new Error('Paste a PEM public key (-----BEGIN PUBLIC KEY-----) or a JWK.');
  return crypto.subtle.importKey('spki', der, params, false, ['verify']);
}

function secretBytes(secret: string, encoding: 'utf8' | 'base64'): Uint8Array<ArrayBuffer> {
  if (encoding === 'utf8') return ascii(secret);
  const s = secret.trim().replace(/\s+/g, '');
  try {
    return base64UrlToBytes(s.replace(/=+$/, ''));
  } catch {
    throw new Error('The secret isn’t valid base64.');
  }
}

const ascii = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export async function verifyJwt(
  token: string,
  alg: unknown,
  kid: unknown,
  key: string,
  secretEncoding: 'utf8' | 'base64',
): Promise<VerifyResult> {
  const info = algInfo(alg);
  if (!info) return { state: 'error', message: `Can’t check "${String(alg)}" signatures here.` };
  if (!crypto?.subtle) return { state: 'error', message: 'This browser can’t check signatures (needs a secure https page).' };
  const [h, p, s] = token.split('.');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlToBytes(s);
  } catch {
    return { state: 'error', message: 'The signature isn’t valid base64url.' };
  }
  const data = ascii(`${h}.${p}`);
  try {
    let ok: boolean;
    if (info.family === 'HS') {
      const k = await crypto.subtle.importKey('raw', secretBytes(key, secretEncoding), { name: 'HMAC', hash: info.hash }, false, ['verify']);
      ok = await crypto.subtle.verify('HMAC', k, sig, data);
    } else {
      const k = await importPublicKey(key, info, kid);
      ok = await crypto.subtle.verify(verifyParams(info), k, sig, data);
    }
    return ok ? { state: 'valid' } : { state: 'invalid' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (info.family === 'EdDSA' && /not supported|unrecognized|NotSupported/i.test(msg)) {
      return { state: 'error', message: 'This browser can’t check EdDSA signatures yet.' };
    }
    if (e instanceof DOMException) return { state: 'error', message: `The key doesn’t fit ${String(alg)}. Check it’s the right type of key.` };
    return { state: 'error', message: msg };
  }
}

/** Builds a fresh HS256 sample token so the expiry countdown is always live. */
export const SAMPLE_SECRET = 'try-me-this-is-not-a-real-secret';
export async function makeSample(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => bytesToBase64Url(ascii(JSON.stringify(o)));
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc({
    sub: '1234567890',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    roles: ['admin', 'editor'],
    iss: 'https://auth.example.com',
    aud: 'ecyzhi.com',
    iat: now,
    nbf: now,
    exp: now + 3600,
  });
  const k = await crypto.subtle.importKey('raw', ascii(SAMPLE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, ascii(`${header}.${payload}`)));
  return `${header}.${payload}.${bytesToBase64Url(sig)}`;
}
