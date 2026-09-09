import { readFileSync } from 'fs';

const wal = readFileSync('src-tauri/target/debug/blesus-files/blesus.db-wal');
const db  = readFileSync('src-tauri/target/debug/blesus-files/blesus.db');

function search(buf, label) {
  const targets = ['default_compose_account_id', 'signature_html', 'Main Account', 'Send Via', 'Send via'];
  for (const t of targets) {
    const b = Buffer.from(t);
    let count = 0;
    for (let i = 0; i < buf.length - b.length; i++) {
      let m = true;
      for (let j = 0; j < b.length; j++) if (buf[i+j] !== b[j]) { m = false; break; }
      if (m) {
        count++;
        const ctx = buf.slice(Math.max(0, i - 10), i + b.length + 40);
        const s = ctx.toString('latin1').replace(/[^\x20-\x7E]/g, '.');
        console.log(`[${label}] "${t}" at ${i}: ${s}`);
      }
    }
    if (count === 0) console.log(`[${label}] "${t}" NOT FOUND`);
  }
}

search(wal, 'WAL');
search(db,  'DB');
