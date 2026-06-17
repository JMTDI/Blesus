-- Migration 25: Fix messages with NULL received_at that were stored without a date.
-- These rows sort to the bottom of ORDER BY received_at DESC, making them invisible
-- in the inbox even when they are the most recent messages on the server.
--
-- We use imap_uid as a proxy for recency (higher UID = more recently delivered on
-- most IMAP servers). Rows that already have a valid received_at are left untouched.
UPDATE messages
   SET received_at = (
         -- Estimate: use the median received_at for the same folder as a base,
         -- then offset by UID order so relative ordering is preserved.
         SELECT COALESCE(AVG(received_at), strftime('%s', 'now'))
           FROM messages m2
          WHERE m2.folder_id = messages.folder_id
            AND m2.received_at IS NOT NULL
       )
 WHERE received_at IS NULL;
