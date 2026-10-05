import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
if (output !== join(root, 'dist') || !output.startsWith(root + sep)) {
  throw new Error('Refusing to replace a directory outside this project');
}

const sources = [
  'index.html', 'app.mjs', 'styles.css',
  'manifest.webmanifest', 'version.json', 'sw.js', 'data/season.json',
  'src/catalog.mjs', 'src/zip.mjs', 'src/quiz.mjs',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/apple-touch-icon.png',
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const source of sources) {
  const destination = join(output, source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, source), destination);
}

const catalog = JSON.parse(await readFile(join(root, 'data/season.json'), 'utf8'));
const version = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'));
version.contentVersion = catalog.patch;
version.updatedAt = catalog.updatedAt;
await writeFile(join(output, 'version.json'), JSON.stringify(version, null, 2) + '\n');

const hashedFiles = sources.filter(path => path !== 'sw.js').sort();
const hash = createHash('sha256');
for (const path of hashedFiles) {
  hash.update(path);
  hash.update(await readFile(join(output, path)));
}
// A worker-only fix must install into a new cache instead of rewriting the
// cache still used by the previous worker and mixing two app versions.
hash.update('sw.js');
hash.update(await readFile(join(root, 'sw.js')));
const buildId = hash.digest('hex').slice(0, 16);
const core = ['./', ...hashedFiles.map(path => './' + path.replaceAll('\\', '/'))];
let worker = await readFile(join(root, 'sw.js'), 'utf8');
if (!/const APP_VERSION = '[^']+';/.test(worker) || !/const CORE = \[[\s\S]*?\];/.test(worker)) {
  throw new Error('Service worker template markers are missing');
}
worker = worker.replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${buildId}';`);
worker = worker.replace(/const CORE = \[[\s\S]*?\];/, `const CORE = ${JSON.stringify(core, null, 2)};`);
await writeFile(join(output, 'sw.js'), worker);
await writeFile(join(output, '.nojekyll'), '');

console.log(`Built ${relative(root, output)} with ${hashedFiles.length} cached assets (${buildId})`);
