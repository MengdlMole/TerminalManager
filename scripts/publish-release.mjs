// Called only after all native builds succeed. Never publishes or modifies a public release.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

const targets = ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu'];
const directory = path.resolve('release-assets');
const { RELEASE_TAG: tag, RELEASE_VERSION: version, RELEASE_COMMIT: commit, GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository } = process.env;
if (!token || !repository || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '') || tag !== `v${version}` || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('Missing or invalid release environment');
}
const assets = [];
for (const target of targets) {
  const manifest = JSON.parse(await readFile(path.join(directory, `manifest-${target}.json`), 'utf8'));
  if (manifest.target !== target || manifest.version !== version || manifest.commit !== commit) throw new Error(`Mismatched build: ${target}`);
  for (const asset of manifest.assets) {
    if (asset.name !== path.basename(asset.name) || !asset.name.includes(`_${version}_${target}`) || assets.includes(asset.name)) throw new Error('Invalid or duplicate asset name');
    const bytes = await readFile(path.join(directory, asset.name));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.name}`);
    assets.push(asset.name);
  }
}
// Reject unexpected files, rather than accidentally publishing a local build or credentials.
const expected = new Set([...assets, ...targets.map(target => `manifest-${target}.json`)]);
for (const name of await readdir(directory)) {
  if (!expected.has(name) && name !== 'SHA256SUMS.txt') throw new Error(`Unexpected release file: ${name}`);
}
const checksums = [];
for (const name of assets.toSorted()) {
  checksums.push(`${createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')}  ${name}`);
}
await writeFile(path.join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
assets.push('SHA256SUMS.txt');

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const base = `${api}/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
let release;
const existing = await fetch(`${base}/releases/tags/${encodeURIComponent(tag)}`, { headers, signal: AbortSignal.timeout(30000) });
if (existing.ok) {
  release = await existing.json();
  if (!release.draft) throw new Error('Release already published; refusing to replace public assets. Use a new version tag.');
} else if (existing.status === 404) {
  release = await request(`${base}/releases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: `Terminal Manager ${tag}`, draft: true,
      prerelease: true, make_latest: 'false', body: `## Terminal Manager ${tag}\n\nBuild commit: ${commit}\n\n- Windows x64: setup.exe installer\n- macOS Apple Silicon / Intel: separate DMG installers\n- Linux x64: AppImage and DEB\n- tmctl: separate CLI archives for each target\n- Verify downloads with SHA256SUMS.txt\n\nThis is a draft prerelease. Native builds and automated tests completed; keyboard, IME, clipboard and AI CLI interactions still need manual validation on each platform.\n\nmacOS packages are ad-hoc signed, not Apple notarized. Windows installers are not code-signed. Review the assets and release notes before publishing.` }),
  });
} else {
  throw new Error(`Cannot look up release: HTTP ${existing.status}`);
}
const oldAssets = await request(`${base}/releases/${release.id}/assets?per_page=100`);
for (const name of assets) {
  // Reruns can replace only matching generated assets of an unpublished draft.
  const current = await request(`${base}/releases/${release.id}`);
  if (!current.draft) throw new Error('Release was published while uploading; aborting');
  const old = oldAssets.find(asset => asset.name === name);
  if (old) await request(`${base}/releases/assets/${old.id}`, { method: 'DELETE' });
  await request(`${release.upload_url.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await readFile(path.join(directory, name)),
  });
  console.log(`Uploaded ${name}`);
}
console.log(`Draft ready: ${release.html_url}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Release draft\n\n[Review ${tag}](${release.html_url})\n\nAll four targets uploaded. The release remains a draft prerelease; publish it manually after validation.\n`);
