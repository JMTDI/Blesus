-- Persistent attachment disk cache tracking table.
-- Actual bytes are stored as binary files in the attachment-cache/ subfolder
-- next to cursus.db. This table tracks metadata for LRU eviction.
CREATE TABLE IF NOT EXISTS attachment_cache (
  account_id   INTEGER NOT NULL,
  folder_path  TEXT    NOT NULL,
  imap_uid     INTEGER NOT NULL,
  att_index    INTEGER NOT NULL,
  file_name    TEXT    NOT NULL,  -- relative filename inside attachment-cache/
  byte_size    INTEGER NOT NULL,  -- size of cached file in bytes
  last_used    INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, folder_path, imap_uid, att_index)
);
CREATE INDEX IF NOT EXISTS idx_attachment_cache_last_used ON attachment_cache(last_used);
