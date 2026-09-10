import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Pinned official release. Downloads happen at build time, never on the phone.
const version = '1.21.0';
const archiveHash = 'a8113b5928ba1a934b81557b61b8a07954b76921a4b567d54c7f086f8b39d9a2';
const binaryHash = 'e47c58c398adbcaa2cbd545fdd908b9c2e36db4c7a4590fd2e746d3cbf28ae6b';
const root = fileURLToPath(new URL('../out/live-recorder/', import.meta.url));
const binary = path.join(root, 'jniLibs/arm64-v8a/libmediamtx.so');
const license = path.join(root, 'assets/third_party/mediamtx-LICENSE.txt');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (hash(await readFile(binary)) === binaryHash && (await readFile(license)).length) process.exit(0);
} catch { /* First build prepares the pinned runtime. */ }
await mkdir(path.dirname(binary), { recursive: true });
await mkdir(path.dirname(license), { recursive: true });
const url = `https://github.com/bluenviron/mediamtx/releases/download/v${version}/mediamtx_v${version}_linux_arm64.tar.gz`;
const archivePath = path.join(root, 'runtime.tar.gz');
execFileSync('curl', ['--fail', '--location', '--retry', '2', '--max-time', '120', '--silent', '--show-error', '--output', archivePath, url]);
const archive = await readFile(archivePath);
if (hash(archive) !== archiveHash) throw new Error('MediaMTX archive checksum mismatch');
execFileSync('tar', ['-xzf', archivePath, '-C', root, 'mediamtx', 'LICENSE']);
const bytes = await readFile(path.join(root, 'mediamtx'));
if (hash(bytes) !== binaryHash) throw new Error('MediaMTX binary checksum mismatch');
await writeFile(binary, bytes);
await copyFile(path.join(root, 'LICENSE'), license);
console.log(`Prepared MediaMTX ${version} offline recording runtime (arm64).`);
