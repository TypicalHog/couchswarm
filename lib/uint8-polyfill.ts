// webtorrent's prebuilt bundle and @thaunknown/simple-peer both reach for Uint8Array's hex and base64
// methods with no fallback of their own, and those methods shipped well after the browsers CouchSwarm
// promises to support, so building a peer id or hashing a piece throws 'toBase64 is not a function' on
// an otherwise capable browser. Importing this module before either bundle fills the gap in place.
const bytes = Uint8Array.prototype as { toHex?: (this: Uint8Array) => string; toBase64?: (this: Uint8Array) => string };
const Bytes = Uint8Array as unknown as { fromHex?: (hex: string) => Uint8Array; fromBase64?: (base64: string) => Uint8Array };

if (!bytes.toHex) bytes.toHex = function () {
  let hex = '';
  for (const byte of this) hex += byte.toString(16).padStart(2, '0');
  return hex;
};

if (!Bytes.fromHex) Bytes.fromHex = hex => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

if (!bytes.toBase64) bytes.toBase64 = function () {
  let binary = '';
  for (const byte of this) binary += String.fromCharCode(byte);
  return btoa(binary);
};

if (!Bytes.fromBase64) Bytes.fromBase64 = base64 => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

// A side-effect module: the empty export keeps it one for TypeScript.
export {};
