import type { Env, OAuthTokenSet } from './types';

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptTokens(env: Env, tokens: OAuthTokenSet): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(tokens));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env.TOKEN_ENCRYPTION_KEY), encoded);
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(cipher)))}`;
}

export async function decryptTokens(env: Env, value: string): Promise<OAuthTokenSet> {
  const [ivText, cipherText] = value.split('.');
  if (!ivText || !cipherText) throw new Error('Du lieu token khong hop le.');
  const iv = Uint8Array.from(atob(ivText), (char) => char.charCodeAt(0));
  const cipher = Uint8Array.from(atob(cipherText), (char) => char.charCodeAt(0));
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await encryptionKey(env.TOKEN_ENCRYPTION_KEY), cipher);
  return JSON.parse(new TextDecoder().decode(clear)) as OAuthTokenSet;
}
