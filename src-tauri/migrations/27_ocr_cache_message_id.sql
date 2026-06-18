-- Add message_id_header column to attachment_ocr_cache so OCR results can be
-- found by Message-ID even after the source-folder messages row is deleted
-- (e.g. after an IMAP MOVE to Archive assigns a new UID and deletes the old row).
-- Note: folder_path column is kept for backwards compatibility but is no longer
-- used as part of the cache key — lookups now use message_id_header directly.
ALTER TABLE attachment_ocr_cache ADD COLUMN message_id_header TEXT;
CREATE INDEX IF NOT EXISTS idx_ocr_cache_message_id
  ON attachment_ocr_cache (account_id, message_id_header, att_index)
  WHERE message_id_header IS NOT NULL;
