/**
 * Folder password hashing using the Web Crypto API (PBKDF2-HMAC-SHA-256).
 * Passwords are never sent anywhere — they're hashed locally and stored in
 * the app's SQLite database solely to gate sidebar folder access.
 *
 * Hash format: "v1:<salt_hex>:<hash_hex>"
 */

const ITERATIONS = 150_000;
const KEY_LENGTH = 32; // bytes → 256-bit

function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      iterations: ITERATIONS,
    },
    keyMaterial,
    KEY_LENGTH * 8,
  );
}

/** Hash a plaintext password and return the storable hash string. */
export async function hashFolderPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `v1:${hexEncode(salt.buffer)}:${hexEncode(hash)}`;
}

/** Verify a plaintext password against a stored hash string. */
export async function verifyFolderPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const parts = storedHash.split(":");
    if (parts[0] !== "v1" || parts.length !== 3) return false;
    const salt = hexDecode(parts[1]!);
    const expectedHash = parts[2]!;
    const actual = await pbkdf2(password, salt);
    return hexEncode(actual) === expectedHash;
  } catch {
    return false;
  }
}
