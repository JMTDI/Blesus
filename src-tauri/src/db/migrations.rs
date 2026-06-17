use tauri_plugin_sql::{Migration, MigrationKind};

pub fn all() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: include_str!("../../migrations/01_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "drafts meta (mode + reply_uid)",
            sql: include_str!("../../migrations/02_drafts_meta.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "search index + FTS5",
            sql: include_str!("../../migrations/03_search_index.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "sent_log local audit table",
            sql: include_str!("../../migrations/04_sent_log.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "messages persistence v2 (nullable thread_id + indices + FTS5)",
            sql: include_str!("../../migrations/05_messages_v2.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "scheduled_sends queue (send later)",
            sql: include_str!("../../migrations/06_scheduled_sends.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "rules / filters",
            sql: include_str!("../../migrations/07_rules.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "account sort order for sidebar drag-reorder",
            sql: include_str!("../../migrations/08_account_sort_order.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "thread repair basket",
            sql: include_str!("../../migrations/09_thread_repair.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "thread repair v2 — original_folder_path + message_id",
            sql: include_str!("../../migrations/10_thread_repair_v2.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "send-only accounts (no IMAP inbox, shown as From options in Composer)",
            sql: include_str!("../../migrations/11_send_via.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "subject_normalized column for exact-match threading",
            sql: include_str!("../../migrations/12_subject_normalized.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "draft body_is_raw flag for Send New HTML preservation",
            sql: include_str!("../../migrations/13_draft_body_is_raw.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "attachments_indexed_at column on search_index",
            sql: include_str!("../../migrations/09_attachments_indexed.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "attachment OCR bounding-box cache",
            sql: include_str!("../../migrations/09_ocr_cache.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "attachment_text column + FTS5 rebuild with attachment content",
            sql: include_str!("../../migrations/10_attachment_text.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "contacts address-book fields + carddav_accounts table",
            sql: include_str!("../../migrations/17_contacts_carddav.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "contact groups (distribution lists)",
            sql: include_str!("../../migrations/18_contact_groups.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "folder password protection",
            sql: include_str!("../../migrations/19_folder_passwords.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "draft attachments JSON",
            sql: include_str!("../../migrations/20_draft_attachments.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "fix subject_normalized backfill — strip Re:/Fwd: prefixes",
            sql: include_str!("../../migrations/21_fix_subject_normalized.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "repair drafts.attachments_json (mig 20 used invalid SQLite syntax)",
            sql: include_str!("../../migrations/22_drafts_attachments_repair.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "imap-only accounts (has inbox, hidden from compose From dropdown)",
            sql: include_str!("../../migrations/23_imap_only.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 24,
            description: "persistent attachment disk cache tracking table",
            sql: include_str!("../../migrations/24_attachment_cache.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
