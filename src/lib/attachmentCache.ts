/**
 * Two-tier attachment cache:
 *
 * Tier 1 — In-memory LRU (fast, session-scoped, up to MAX_MEM_ENTRIES)
 * Tier 2 — Persistent disk cache (survives restarts, up to DISK_CACHE_MAX_BYTES = 4 GB)
 *
 * Key format: `${accountId}:${folderPath}:${uid}:${index}`
 *
 * On load:  memory hit → return immediately
 *           disk hit   → load from disk, promote to memory, update last_used in DB
 *           miss       → fetch from IMAP, write to disk, store in memory
 *
 * Eviction: When total disk cache exceeds DISK_CACHE_MAX_BYTES, the LRU
 *           entries (by last_used) are deleted until under the limit.
 */

import { ipc, type ImapConfig } from "@/lib/ipc";
import { getAccount, getAccountSecrets, getDb } from "@/lib/db";

const DISK_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

const MAX_ENTRIES = 200;

// Ordered map — insertion order = LRU order (oldest first)
const _cache = new Map<string, string>();

function cacheKey(accountId: number, folderPath: string, uid: number, index: number): string {
  return `${accountId}:${folderPath}:${uid}:${index}`;
}

function put(key: string, value: string) {
  if (_cache.has(key)) _cache.delete(key); // refresh position
  _cache.set(key, value);
  if (_cache.size > MAX_ENTRIES) {
    // Evict the oldest entry (first key in insertion order)
    _cache.delete(_cache.keys().next().value!);
  }
}

/** Returns cached b64 or undefined (does not fetch). */
export function getCached(
  accountId: number,
  folderPath: string,
  uid: number,
  index: number,
): string | undefined {
  const key = cacheKey(accountId, folderPath, uid, index);
  const value = _cache.get(key);
  if (value !== undefined) {
    // Refresh LRU position
    _cache.delete(key);
    _cache.set(key, value);
  }
  return value;
}

/** Builds an IMAP config object from the stored account + secrets. */
async function buildConfig(accountId: number): Promise<ImapConfig> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const secrets = await getAccountSecrets(accountId);
  return {
    host: account.imap_host,
    port: account.imap_port,
    username: account.imap_username ?? account.email,
    password: secrets.imapPassword,
    security: account.imap_security,
  };
}

// ── Disk cache helpers ──────────────────────────────────────────────────────

/** Sanitise a cache key into a safe filename. */
function keyToFileName(key: string): string {
  return key.replace(/[:/\\]/g, "_") + ".bin";
}

/** Look up a disk-cache entry, returns b64 or null. Updates last_used in DB. */
async function diskGet(
  accountId: number,
  folderPath: string,
  uid: number,
  index: number,
): Promise<string | null> {
  try {
    const db = await getDb();
    const rows = await db.select<{ file_name: string }[]>(`SELECT file_name FROM attachment_cache WHERE account_id=$1 AND folder_path=$2 AND imap_uid=$3 AND att_index=$4`, [accountId, folderPath, uid, index]).catch(() => null);
    const row = rows?.[0];
    if (!row) return null;
    // Try to read the file
    const b64 = await ipc.attachmentCacheRead(row.file_name).catch(() => null);
    if (b64 === null) {
      // File missing — remove stale DB row
      await db.execute(`DELETE FROM attachment_cache WHERE account_id=$1 AND folder_path=$2 AND imap_uid=$3 AND att_index=$4`, [accountId, folderPath, uid, index]).catch(() => {});
      return null;
    }
    // Update last_used fire-and-forget so it doesn't block the caller
    // or contend with concurrent search-index writes during bulk indexing.
    void db.execute(`UPDATE attachment_cache SET last_used=unixepoch() WHERE account_id=$1 AND folder_path=$2 AND imap_uid=$3 AND att_index=$4`, [accountId, folderPath, uid, index]).catch(() => {});
    return b64;
  } catch {
    return null;
  }
}

/** Write attachment b64 to disk cache, recording metadata in DB. Evicts LRU if over limit. */
async function diskPut(
  accountId: number,
  folderPath: string,
  uid: number,
  index: number,
  b64: string,
): Promise<void> {
  try {
    const key = cacheKey(accountId, folderPath, uid, index);
    const fileName = keyToFileName(key);
    // byte size = b64 length * 0.75 (approximate decoded size)
    const byteSize = Math.ceil(b64.length * 0.75);

    await ipc.attachmentCacheWrite(fileName, b64);

    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO attachment_cache
       (account_id, folder_path, imap_uid, att_index, file_name, byte_size, last_used)
       VALUES ($1, $2, $3, $4, $5, $6, unixepoch())`,
      [accountId, folderPath, uid, index, fileName, byteSize],
    ).catch(() => {});

    // Schedule LRU eviction on a delay so it doesn't contend with
    // search-index writes happening concurrently in indexAllMail / indexNewArrivals.
    scheduleEviction();
  } catch {
    // Non-fatal — disk cache failure just means we skip persisting
  }
}

let _evictionTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounce eviction so multiple rapid diskPut calls coalesce into a single
 * eviction pass, and the pass runs after the current indexing tick has finished
 * writing to the search_index table (avoiding SQLite write contention).
 */
function scheduleEviction() {
  if (_evictionTimer !== null) return; // already scheduled
  _evictionTimer = setTimeout(() => {
    _evictionTimer = null;
    void evictIfNeeded();
  }, 5_000); // 5-second delay
}

/** Evict LRU disk cache entries until total size is under DISK_CACHE_MAX_BYTES. */
async function evictIfNeeded(): Promise<void> {
  try {
    const db = await getDb();
    type CacheSizeRow = { total_bytes: number };
    const sizeResult = await db.select<CacheSizeRow[]>(
      "SELECT COALESCE(SUM(byte_size),0) AS total_bytes FROM attachment_cache", [],
    ).catch(() => null);
    if (!sizeResult || !sizeResult[0]) return;
    let totalBytes = sizeResult[0].total_bytes ?? 0;
    if (totalBytes <= DISK_CACHE_MAX_BYTES) return;

    type LruRow = { file_name: string; byte_size: number; account_id: number; folder_path: string; imap_uid: number; att_index: number };
    const lruRows = await db.select<LruRow[]>(
      `SELECT file_name, byte_size, account_id, folder_path, imap_uid, att_index
       FROM attachment_cache ORDER BY last_used ASC LIMIT 100`, [],
    ).catch(() => null);
    if (!lruRows) return;

    for (const row of lruRows) {
      if (totalBytes <= DISK_CACHE_MAX_BYTES) break;
      await ipc.attachmentCacheDelete(row.file_name).catch(() => {});
      await db.execute(
        `DELETE FROM attachment_cache WHERE account_id=$1 AND folder_path=$2 AND imap_uid=$3 AND att_index=$4`,
        [row.account_id, row.folder_path, row.imap_uid, row.att_index],
      ).catch(() => {});
      totalBytes -= row.byte_size;
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Returns the base-64 data for the attachment, checking memory then disk before
 * fetching from IMAP. Fetched data is persisted to the disk cache for future sessions.
 */
export async function loadAttachmentB64(
  accountId: number,
  folderPath: string,
  uid: number,
  index: number,
): Promise<string> {
  const key = cacheKey(accountId, folderPath, uid, index);

  // Tier 1: memory cache
  const memoryCached = _cache.get(key);
  if (memoryCached !== undefined) {
    _cache.delete(key);
    _cache.set(key, memoryCached);
    return memoryCached;
  }

  // Tier 2: disk cache
  const diskCached = await diskGet(accountId, folderPath, uid, index);
  if (diskCached !== null) {
    put(key, diskCached); // promote to memory
    return diskCached;
  }

  // Tier 3: fetch from IMAP and persist to both caches
  const cfg = await buildConfig(accountId);
  const b64 = await ipc.imapLoadAttachmentB64(cfg, folderPath, uid, index);
  put(key, b64);
  void diskPut(accountId, folderPath, uid, index, b64);
  return b64;
}

/** Pre-warm the cache for a list of (accountId, folderPath, uid, index) tuples concurrently. */
export async function prefetchAttachments(
  accountId: number,
  folderPath: string,
  uid: number,
  indices: number[],
  concurrency = 3,
): Promise<void> {
  const needed = indices.filter(
    (i) => !_cache.has(cacheKey(accountId, folderPath, uid, i)),
  );
  if (needed.length === 0) return;

  let cfg: ImapConfig | null = null;
  const getConfig = async () => {
    if (!cfg) cfg = await buildConfig(accountId);
    return cfg;
  };

  // Process in batches of `concurrency`
  for (let i = 0; i < needed.length; i += concurrency) {
    const batch = needed.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (idx) => {
        const key = cacheKey(accountId, folderPath, uid, idx);
        if (_cache.has(key)) return; // already fetched by a parallel batch
        try {
          const c = await getConfig();
          const b64 = await ipc.imapLoadAttachmentB64(c, folderPath, uid, idx);
          put(key, b64);
        } catch {
          // Non-fatal — item just won't be pre-warmed
        }
      }),
    );
  }
}
