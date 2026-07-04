/**
 * Packages the built app (packages/app/dist) into a versioned, ready-to-upload
 * zip in deploy/ — the owner's manual-webhost deployment flow.
 *
 * Usage: npm run package   (runs the build first via the npm script)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages', 'app', 'dist');
const outDir = join(root, 'deploy');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('packages/app/dist is missing or incomplete — run "npm run build" first.');
  process.exit(1);
}

const versionTs = readFileSync(join(root, 'packages', 'app', 'src', 'version.ts'), 'utf8');
const version = versionTs.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1] ?? 'unknown';

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `online-openrocket-v${version}.zip`);
rmSync(zipPath, { force: true });

if (process.platform === 'win32') {
  // Zip the CONTENTS of dist (not the folder) so it unzips straight into the
  // web directory.
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${dist}\\*' -DestinationPath '${zipPath}'`,
  ], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-rq', zipPath, '.'], { cwd: dist, stdio: 'inherit' });
}

console.log(`\nPackaged v${version} → ${zipPath}`);
console.log('Upload the zip contents (or unzip on the server) into your web folder.');
