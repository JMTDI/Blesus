import { readFileSync } from 'fs';

const db = readFileSync('src-tauri/target/debug/blesus-files/blesus.db');

// Find exact account rows by email
function findAndShowContext(email, windowSize = 200) {
  const b = Buffer.from(email);
  for (let i = 0; i < db.length - b.length; i++) {
    let m = true;
    for (let j = 0; j < b.length; j++) if (db[i+j] !== b[j]) { m=false; break; }
    if (m) {
      const start = Math.max(0, i - 20);
      const end = Math.min(db.length, i + windowSize);
      const raw = db.slice(start, end);
      // Show as both hex and latin1
      const latin = raw.toString('latin1').replace(/[^\x20-\x7E]/g, '·');
      const hex = [...raw].map(x => x.toString(16).padStart(2,'0')).join(' ');
      console.log(`\n=== "${email}" found at offset ${i} ===`);
      console.log('TEXT:', latin);
      console.log('HEX: ', hex);
      break; // Only show first match
    }
  }
}

findAndShowContext('martinautocenter@fastmail.com', 300);
findAndShowContext('clarence@martinautocenter.com', 300);
