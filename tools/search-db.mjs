import { readFileSync } from 'fs';

const buf = readFileSync('C:/Users/CM/Downloads/blesus-main/blesus-main/src-tauri/target/debug/blesus-files/blesus.db');
const wal = readFileSync('C:/Users/CM/Downloads/blesus-main/blesus-main/src-tauri/target/debug/blesus-files/blesus.db-wal');

function searchBuf(b, label) {
  const terms = ['Main Account', 'Send Via', 'Send via', 'signature_html'];
  for (const term of terms) {
    const t = Buffer.from(term);
    let found = false;
    for (let i = 0; i < b.length - t.length; i++) {
      let match = true;
      for (let j = 0; j < t.length; j++) { if (b[i+j] !== t[j]) { match = false; break; } }
      if (match) {
        if (!found) { found = true; }
        const ctx = b.slice(Math.max(0, i-25), i + t.length + 25);
        const text = ctx.toString('latin1').replace(/[^\x20-\x7E]/g, '.');
        console.log(`${label}: "${term}" at offset ${i}: ${text}`);
      }
    }
  }
}

searchBuf(buf, 'DB');
searchBuf(wal, 'WAL');
