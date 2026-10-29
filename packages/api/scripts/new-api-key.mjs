import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const [name, ...existingArgs] = args.filter(arg => arg !== '--hash');
// Blank entries are skipped, as the Worker skips them; a malformed non-empty one is refused.
const existing = existingArgs.flatMap(arg => arg.split(/[\n,]/).map(entry => entry.trim()).filter(Boolean));
if (!name || !/^[a-z0-9-]{1,32}$/.test(name) || existing.some(entry => !/^[a-z0-9-]{1,32}:[a-f0-9]{64}$/.test(entry))) {
  console.error('Usage: node scripts/new-api-key.mjs <name> [--hash] [existing-name:hash ...]');
  process.exitCode = 1;
} else {
  let key;
  if (args.includes('--hash')) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    key = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!key || /\s/.test(key)) {
      console.error('Supply one non-empty key on stdin.');
      process.exitCode = 1;
    }
  } else {
    key = randomBytes(32).toString('base64url');
    console.log('Key (shown once): ' + key);
  }
  if (!process.exitCode) {
    const retained = existing.filter(entry => !entry.startsWith(name + ':'));
    if (retained.length !== existing.length) console.error('Replaced the existing ' + name + ' entry.');
    console.log([...retained, name + ':' + createHash('sha256').update(key).digest('hex')].join(','));
    if (!args.includes('--hash')) {
      console.log('In packages/api: npx wrangler secret put API_KEYS');
      console.log('Paste the single comma-separated name:hash line, including existing keys.');
      console.log('Send the key by a one-time link, never plain email.');
    }
  }
}
