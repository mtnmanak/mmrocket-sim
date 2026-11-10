/**
 * Packages the built app (packages/app/dist) into a versioned, ready-to-upload
 * zip in deploy/ — the owner's manual-webhost deployment flow.
 *
 * Usage: npm run package   (runs the build first via the npm script)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../packages/app/scripts/atomic-write.mjs';
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

// version.json (repo root, hand-maintained per release) ships at the app's
// root so the owner's online-tools page can poll it and prompt a refresh. It is
// copied AFTER the build, so the service worker never precaches it — polls
// always hit the network. Release checklist enforcement: its version must
// match APP_VERSION or the package fails.
const versionJsonPath = join(root, 'version.json');
if (!existsSync(versionJsonPath)) {
  console.error('version.json is missing from the repo root — create it before packaging.');
  process.exit(1);
}
const versionJson = JSON.parse(readFileSync(versionJsonPath, 'utf8'));
if (versionJson.version !== version) {
  console.error(`version.json says ${versionJson.version} but APP_VERSION is ${version} — `
    + 'update version.json (version, released, note) before packaging.');
  process.exit(1);
}
atomicWriteFileSync(join(dist, 'version.json'), readFileSync(versionJsonPath));

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `online-openrocket-v${version}.zip`);
// Keep the .zip suffix for bsdtar's automatic format selection.
const temporaryZip = `${zipPath}.${randomUUID()}.tmp.zip`;

try {
  if (process.platform === 'win32') {
    // NOT Compress-Archive: it writes BACKSLASH entry paths, which Linux-side
    // unzip tools (web-host file managers!) mishandle — the assets/ folder
    // never gets created and the deploy breaks. Windows 10+ ships bsdtar,
    // which writes standard forward-slash zip entries.
    // Absolute path: PATH may resolve tar.exe to Git's GNU tar (no zip support).
    const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(bsdtar, ['-a', '-c', '-f', temporaryZip, '-C', dist,
      ...readdirSync(dist)], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-rq', temporaryZip, '.'], { cwd: dist, stdio: 'inherit' });
  }
  renameSync(temporaryZip, zipPath);
} finally {
  rmSync(temporaryZip, { force: true });
}

console.log(`\nPackaged v${version} → ${zipPath}`);
console.log('Upload the zip contents (or unzip on the server) into your web folder.');
