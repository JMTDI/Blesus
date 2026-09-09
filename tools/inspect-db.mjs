import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Use the project's better-sqlite3 if available, otherwise try built-in approach
const DB_PATH = 'C:/Users/CM/Downloads/blesus-main/blesus-main/src-tauri/target/debug/blesus-files/blesus.db';

try {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });

  console.log('\n=== Migration versions ===');
  try {
    const rows = db.prepare('SELECT version FROM tauri_plugin_migrations ORDER BY version DESC LIMIT 5').all();
    console.log(rows);
  } catch(e) {
    // Try alternate migration table name
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%migr%'").all();
    console.log('Migration tables:', tables);
  }

  console.log('\n=== sent_log subject_normalized ===');
  const sl = db.prepare("SELECT id, subject, subject_normalized, reply_uid, account_id FROM sent_log ORDER BY sent_at DESC LIMIT 10").all();
  sl.forEach(r => console.log(r));

  console.log('\n=== messages "Re: argen" or "argen" ===');
  const msgs = db.prepare("SELECT imap_uid, folder_id, subject, subject_normalized, account_id FROM messages WHERE subject LIKE '%argen%' LIMIT 20").all();
  msgs.forEach(r => console.log(r));

  console.log('\n=== folders special_use ===');
  const folders = db.prepare("SELECT id, account_id, name, path, special_use FROM folders").all();
  folders.forEach(r => console.log(r));

  db.close();
} catch(e) {
  console.error('better-sqlite3 not available:', e.message);
  console.log('Trying manual binary read to find migration table...');
  
  // Read file as binary and search for text
  import('fs').then(({readFileSync}) => {
    const buf = readFileSync(DB_PATH);
    const text = buf.toString('utf8', 0, Math.min(buf.length, 100000));
    const idx = text.indexOf('tauri_plugin');
    console.log('Found tauri_plugin at offset:', idx);
    if (idx > 0) console.log('Context:', text.slice(idx, idx+200));
  });
}
