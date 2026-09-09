import { readFileSync } from 'fs';

const buf = readFileSync('C:/Users/CM/Downloads/blesus-main/blesus-main/src-tauri/target/debug/blesus-files/blesus.db');
const wal = readFileSync('C:/Users/CM/Downloads/blesus-main/blesus-main/src-tauri/target/debug/blesus-files/blesus.db-wal');

// Find the accounts section - look for email addresses and their nearby signature_html
// We'll dump a range around account IDs 1 and 2

// First find the string "autocenter" or any email domain
const terms = ['Send via', 'autocenter', 'fastmail'];
function searchAll(b, label) {
  for (const term of terms) {
    const t = Buffer.from(term);
    for (let i = 0; i < b.length - t.length; i++) {
      let match = true;
      for (let j = 0; j < t.length; j++) {
        if (b[i + j] !== t[j]) { match = false; break; }
      }
      if (match) {
        const ctx = b.slice(Math.max(0, i - 30), i + t.length + 80);
        const text = ctx.toString('latin1').replace(/[^\x20-\x7E]/g, '·');
        console.log(`${label} "${term}" @${i}: ${text}`);
      }
    }
  }
}

searchAll(buf, 'DB');
// Don't search WAL - too slow for now
console.log('Done');
