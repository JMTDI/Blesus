-- Add message_id_header to search_index so attachment text can be found
-- directly by message ID after an IMAP MOVE reassigns the UID.
--
-- Previously getAttachmentTextByMessageId joined search_index → folders →
-- messages, but after a MOVE the source-folder messages row is deleted by
-- purgeDeletedMessages before the destination folder stamps its new
-- search_index row — breaking the join and causing unnecessary re-OCR.
--
-- With message_id_header stored directly on search_index we can query it
-- without any join through the messages table.

ALTER TABLE search_index ADD COLUMN message_id_header TEXT;

-- Backfill from the messages table where a match exists.
UPDATE search_index
   SET message_id_header = (
         SELECT m.message_id_header
           FROM messages m
           JOIN folders f ON f.id = m.folder_id
          WHERE m.account_id       = search_index.account_id
            AND f.path             = search_index.folder_path
            AND m.imap_uid         = search_index.imap_uid
          LIMIT 1
       );

CREATE INDEX IF NOT EXISTS idx_search_index_message_id
    ON search_index (account_id, message_id_header)
 WHERE message_id_header IS NOT NULL;
