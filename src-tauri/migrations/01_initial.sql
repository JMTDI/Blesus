-- Initial schema for Flow mail.
-- SQLite, used via tauri-plugin-sql. Statements separated by `;`.

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    color TEXT,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_security TEXT NOT NULL CHECK(imap_security IN ('ssl','starttls','none')),
    imap_username TEXT,
    imap_password_enc BLOB NOT NULL,
    smtp_mode TEXT NOT NULL DEFAULT 'smtp' CHECK(smtp_mode IN ('smtp','resend')),
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_security TEXT CHECK(smtp_security IN ('ssl','starttls','none')),
    smtp_username TEXT,
    smtp_password_enc BLOB,
    resend_api_key_enc BLOB,
    resend_from_address TEXT,
    signature_html TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    is_imap_only INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    delimiter TEXT,
    special_use TEXT,
    uid_validity INTEGER,
    last_uid INTEGER,
    unread_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, path)
);

CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);

CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    subject TEXT,
    snippet TEXT,
    participants TEXT,
    message_count INTEGER NOT NULL DEFAULT 1,
    has_unread INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    category TEXT CHECK(category IN ('people','notifications','newsletters','pinned') OR category IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_threads_folder_date ON threads(folder_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    imap_uid INTEGER,
    message_id_header TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    from_address TEXT,
    to_addresses TEXT,
    cc_addresses TEXT,
    bcc_addresses TEXT,
    subject TEXT,
    snippet TEXT,
    html_body TEXT,
    text_body TEXT,
    received_at INTEGER,
    flags TEXT,
    is_unread INTEGER NOT NULL DEFAULT 1,
    is_starred INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, folder_id, imap_uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject, from_address, to_addresses, text_body,
    content='messages', content_rowid='id',
    tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT,
    content_type TEXT,
    size_bytes INTEGER,
    imap_part_id TEXT,
    cached_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    last_interaction_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS resend_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    resend_template_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT,
    cached_html TEXT,
    cached_at INTEGER,
    UNIQUE(account_id, resend_template_id)
);

CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    to_addresses TEXT,
    cc_addresses TEXT,
    bcc_addresses TEXT,
    subject TEXT,
    html_body TEXT,
    text_body TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO workspaces (id, name, color, sort_order) VALUES (1, 'Default', '#5B8DEF', 0);

INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'system');
INSERT OR IGNORE INTO settings (key, value) VALUES ('reading_pane', 'right');
INSERT OR IGNORE INTO settings (key, value) VALUES ('density', 'comfortable');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smart_inbox_enabled', 'true');
