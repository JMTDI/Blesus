import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dbPath = 'C:/Users/CM/Downloads/blesus-main/blesus-main/src-tauri/target/debug/blesus-files/blesus.db';
try {
  const db = require('better-sqlite3')(dbPath);
  console.log('=== ACCOUNTS ===');
  db.prepare('SELECT id, email, is_send_only, signature_html FROM accounts ORDER BY sort_order').all()
    .forEach(r => console.log('id=' + r.id + ' email=' + r.email + ' send_only=' + r.is_send_only + ' sig=' + (r.signature_html||'').slice(0,50)));
  console.log('\n=== SETTINGS ===');
  const setting = db.prepare("SELECT key, value FROM settings WHERE key='default_compose_account_id'").all();
  if (setting.length) setting.forEach(r => console.log(r.key + ' = ' + r.value));
  else console.log('default_compose_account_id = (not set)');
} catch(e) {
  console.log('Error:', e.message);
}
