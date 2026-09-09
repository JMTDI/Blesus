import { readFileSync } from 'fs';

const wal = readFileSync('src-tauri/target/debug/blesus-files/blesus.db-wal');
const db  = readFileSync('src-tauri/target/debug/blesus-files/blesus.db');

function searchAll(buf, label) {
  // Search for email-like patterns that could be account data
  const targets = [
    'fastmail', 'autocenter', 'autoc', '@',
    'Main Account', 'Send Via', 'Send via',
    'Main', 'signature',
  ];
  
  // Also look for any printable string near "is_send_only" (column that should be near signature_html)
  const t = Buffer.from('is_send_only');
  let accountRows = [];
  for (let i = 0; i < buf.length - t.length; i++) {
    let m = true;
    for (let j = 0; j < t.length; j++) if (buf[i+j] !== t[j]) { m=false; break; }
    if (m) {
      const ctx = buf.slice(Math.max(0, i - 60), i + t.length + 60);
      const s = ctx.toString('latin1').replace(/[^\x20-\x7E]/g, '.');
      // Only show if it's a data row (not a schema definition)
      if (!s.includes('INTEGER') && !s.includes('DEFAULT') && !s.includes('NOT NULL')) {
        accountRows.push(`[${label}] "is_send_only" data at ${i}: ${s}`);
      }
    }
  }
  
  if (accountRows.length > 0) {
    console.log('=== ACCOUNT ROW DATA (near is_send_only column) ===');
    accountRows.forEach(r => console.log(r));
  } else {
    console.log(`[${label}] No account data rows found near "is_send_only"`);
  }
}

// Also search for fastmail.com or autocenter.com in both files  
function searchEmail(buf, label) {
  const targets = ['fastmail.com', 'autocenter.com', '@'];
  for (const t of targets) {
    const b = Buffer.from(t);
    let count = 0;
    for (let i = 0; i < buf.length - b.length; i++) {
      let m = true;
      for (let j = 0; j < b.length; j++) if (buf[i+j] !== b[j]) { m=false; break; }
      if (m) {
        count++;
        if (count <= 5) { // Only show first 5 occurrences
          const ctx = buf.slice(Math.max(0, i - 30), i + b.length + 80);
          const s = ctx.toString('latin1').replace(/[^\x20-\x7E]/g, '.');
          console.log(`[${label}] "${t}" at ${i}: ...${s}...`);
        }
      }
    }
    if (count === 0) console.log(`[${label}] "${t}" NOT FOUND`);
    else if (count > 5) console.log(`[${label}] "${t}" total ${count} occurrences (showing first 5)`);
  }
}

console.log('=== WAL ===');
searchAll(wal, 'WAL');
searchEmail(wal, 'WAL');
console.log('\n=== DB ===');
searchAll(db, 'DB');
searchEmail(db, 'DB');
