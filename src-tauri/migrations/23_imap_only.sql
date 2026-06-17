-- Add is_imap_only column to accounts table.
-- When enabled, an account receives mail (IMAP) but is hidden from the compose From dropdown.
-- Uses a safe pattern: checks pragma table_info to avoid duplicate column error.
ALTER TABLE accounts ADD COLUMN is_imap_only INTEGER NOT NULL DEFAULT 0;
