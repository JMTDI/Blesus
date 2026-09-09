import { readFileSync } from 'fs';

const db = readFileSync('src-tauri/target/debug/blesus-files/blesus.db');
const wal = readFileSync('src-tauri/target/debug/blesus-files/blesus.db-wal');

// Find ALL occurrences of both account emails and show significant context
function findAll(buf, label, email) {
  const b = Buffer.from(email);
  let n = 0;
  for (let i = 0; i < buf.length - b.length; i++) {
    let m = true;
    for (let j = 0; j < b.length; j++) if (buf[i+j] !== b[j]) { m=false; break; }
    if (m) {
      n++;
      const end = Math.min(buf.length, i + b.length + 250);
      const raw = buf.slice(i, end);
      const latin = raw.toString('latin1').replace(/[^\x20-\x7E]/g, '·');
      console.log(`\n[${label}] #${n} "${email}" at ${i}:`);
      console.log(latin);
    }
  }
  if (n === 0) console.log(`[${label}] "${email}" NOT FOUND`);
}

console.log('=== ALL OCCURRENCES OF ACCOUNT 1 (fastmail) ===');
findAll(db, 'DB', 'martinautocenter@fastmail.com');

console.log('\n\n=== ALL OCCURRENCES OF ACCOUNT 2 (autocenter) ===');
findAll(db, 'DB', 'clarence@martinautocenter.com');
