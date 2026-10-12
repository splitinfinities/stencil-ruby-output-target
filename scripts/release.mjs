// Releases the package to npm: checks, a version bump, the build, `npm publish`, then a commit
// and a tag, pushed when the repository has a remote.
//
//   node scripts/release.mjs <version | patch | minor | major> [options]
//
//   --dry-run        everything but the release: the checks, the build, the tarball's contents and
//                    `npm publish --dry-run`. package.json is put back; nothing is committed.
//   --tag <name>     the npm dist-tag (default: latest; a prerelease version defaults to next)
//   --otp <code>     a one-time password, for an account with 2FA on publish
//   --no-push        don't push the commit and tag
//   --any-branch     release from a branch other than main
//
// Before the first release: `npm login`. The order is publish, then commit and tag, so a failed
// publish leaves nothing behind but a restored package.json.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'package.json');

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    tag: { type: 'string' },
    otp: { type: 'string' },
    'no-push': { type: 'boolean', default: false },
    'any-branch': { type: 'boolean', default: false },
  },
});

const dryRun = flags['dry-run'];

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });

/** A command's output, or undefined when it fails. */
function output(command, args) {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const step = (message) => console.log(`\n▸ ${message}`);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The version to release: one given outright, or the current one bumped. */
function nextVersion(current, request) {
  if (SEMVER.test(request)) return request;
  const match = current.match(SEMVER);

  if (!match) fail(`package.json's version ${current} isn't x.y.z`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);

  if (request === 'major') return `${major + 1}.0.0`;

  if (request === 'minor') return `${major}.${minor + 1}.0`;

  if (request === 'patch') return `${major}.${minor}.${patch + 1}`;

  return fail(`"${request}" isn't a version (x.y.z, x.y.z-next.0) or patch, minor or major`);
}

/** Whether `a` is a later release than `b`, comparing the numbers only. */
function isLater(a, b) {
  const [x, y] = [a, b].map((version) => version.match(SEMVER).slice(1, 4).map(Number));

  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }

  return false;
}

const request = positionals[0];

if (!request) fail('which version? node scripts/release.mjs <x.y.z | patch | minor | major> [--dry-run]');

const original = readFileSync(MANIFEST, 'utf8');
const manifest = JSON.parse(original);
const version = nextVersion(manifest.version, request);
const prerelease = version.includes('-');
const distTag = flags.tag ?? (prerelease ? 'next' : 'latest');

// What must be true before anything changes.
step(`${manifest.name} ${manifest.version} → ${version} (${distTag})${dryRun ? ', dry run' : ''}`);

if (manifest.private) fail('package.json is private');

if (!prerelease && !isLater(version, manifest.version) && manifest.version !== '0.0.0') fail(`${version} isn't later than ${manifest.version}`);

if (output('git', ['status', '--porcelain']) !== '') fail('the working tree has changes; commit or stash them first');

const branch = output('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

if (branch !== 'main' && !flags['any-branch']) fail(`on ${branch}, not main (--any-branch to release anyway)`);

if (output('git', ['tag', '--list', `v${version}`])) fail(`the tag v${version} exists`);

if (output('npm', ['view', `${manifest.name}@${version}`, 'version'])) fail(`${manifest.name}@${version} is already on npm`);

const user = output('npm', ['whoami']);

if (!user && !dryRun) fail('not logged in to npm: run `npm login` first');
console.log(user ? `npm user: ${user}` : 'npm user: not logged in (fine for a dry run)');

let published = false;

try {
  writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

  step('typecheck, test, build');
  run('pnpm', ['typecheck']);
  run('pnpm', ['test']);
  run('pnpm', ['build']);

  step('the tarball');
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const files = pack.files.map((file) => file.path);
  const required = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.cjs', 'dist/cli.js', 'dist/types/index.d.ts', 'runtime/stencil-bridge.ts', 'runtime/manifest.ts'];
  const missing = required.filter((file) => !files.includes(file));
  const stray = files.filter((file) => /^(src|test|scripts|node_modules)\//.test(file));

  console.log(`${files.length} files, ${(pack.size / 1024).toFixed(1)} kB packed, ${(pack.unpackedSize / 1024).toFixed(1)} kB unpacked`);

  if (missing.length) fail(`the tarball is missing ${missing.join(', ')}`);

  if (stray.length) fail(`the tarball has files that shouldn't ship: ${stray.slice(0, 5).join(', ')}`);

  step('the built entry points load');
  const esm = await import(`${pathToFileURL(join(ROOT, 'dist/index.js')).href}?v=${version}`);
  const cjs = createRequire(import.meta.url)(join(ROOT, 'dist/index.cjs'));

  for (const [format, loaded] of [['ESM', esm], ['CommonJS', cjs]]) {
    if (typeof loaded.rubyOutputTarget !== 'function' || typeof loaded.generate !== 'function') fail(`the ${format} build doesn't export rubyOutputTarget and generate`);
  }

  if (!output('node', ['dist/cli.js', '--help'])?.includes('--config')) fail("the built CLI (dist/cli.js --help) doesn't run");
  console.log('ESM, CommonJS and the CLI load');

  step(dryRun ? 'npm publish --dry-run' : 'npm publish');
  // prepublishOnly would run the checks a second time.
  const publish = ['publish', '--access', 'public', '--tag', distTag, '--ignore-scripts'];

  if (flags.otp) publish.push('--otp', flags.otp);

  if (dryRun) publish.push('--dry-run');
  run('npm', publish);
  published = !dryRun;
} finally {
  // A dry run, or a release that didn't get as far as npm, leaves package.json as it was.
  if (!published) writeFileSync(MANIFEST, original);
}

if (dryRun) {
  console.log(`\nDry run done: ${manifest.name}@${version} was not published, and nothing was committed.`);
  process.exit(0);
}

step(`commit and tag v${version}`);
run('git', ['add', 'package.json']);
run('git', ['commit', '-m', `release: v${version}`]);
run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`]);

const remote = output('git', ['remote']);

if (flags['no-push']) {
  console.log('\nNot pushed (--no-push): git push --follow-tags');
} else if (!remote) {
  console.log('\nNo git remote, so nothing was pushed. Once there is one: git push -u origin main --follow-tags');
} else {
  step('push');
  run('git', ['push', '--follow-tags']);
}

console.log(`\nReleased ${manifest.name}@${version}: https://www.npmjs.com/package/${manifest.name}/v/${version}`);
