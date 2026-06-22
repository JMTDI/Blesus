-- Dedicated cache for extracted attachment text, keyed by message_id_header.
-- Unlike search_index.attachment_text (which is pruned when a message moves
-- folders), this table persists across IMAP MOVEs so that indexNewArrivals
-- can find previously-extracted text for any UID reassignment without
-- triggering a full rescan.
CREATE TABLE IF NOT EXISTS attachment_text_cache (
    account_id          INTEGER NOT NULL,
    message_id_header   TEXT    NOT NULL,
    attachment_text     TEXT    NOT NULL,
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (account_id, message_id_header)
);

-- Backfill from existing search_index rows that have both fields.
INSERT OR IGNORE INTO attachment_text_cache (account_id, message_id_header, attachment_text)
SELECT account_id, message_id_header, attachment_text
  FROM search_index
 WHERE message_id_header IS NOT NULL
   AND attachment_text IS NOT NULL
   AND length(attachment_text) > 0;
