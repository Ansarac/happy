// Fork-only (Ansarac/happy) companion to cli-release.cjs.
//
// Upstream's cli-release.cjs drives the npm release of `happy` and only
// accepts X.Y.Z or X.Y.Z-beta.N (releaseInput), taking the version from
// RELEASE_VERSION. This fork ships its own builds as GitHub Release tarballs
// with a `-ansarac.<n>` version, which that validation rejects by design. So
// instead of editing the upstream file (and conflicting on every rebase),
// this wrapper reuses its exported checks (checkManifest, checkPackage,
// checkVersionOutput) and adds only what the fork needs: computing the fork
// version and stamping it.
//
// Used by .github/workflows/cli-package.yml and scripts/install-happy-cli.mjs.
//
//   node scripts/fork-cli-package.cjs version <run_number>
//   node scripts/fork-cli-package.cjs prepare <package.json> <version>
//   node scripts/fork-cli-package.cjs check-package <unpacked dir> <version>
//   node scripts/fork-cli-package.cjs smoke <npm prefix> <version>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkManifest, checkPackage, checkVersionOutput } = require('./cli-release.cjs');

const FORK_ID = 'ansarac';
const CLI_PACKAGE_JSON = path.join(__dirname, '..', 'packages', 'happy-cli', 'package.json');

// semver.org's reference regex: no leading zeros in numeric identifiers.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// `<base>-ansarac.<suffix>`, or `<base>.ansarac.<suffix>` when the base is
// already a prerelease (1.2.5-beta.0 -> 1.2.5-beta.0.ansarac.12), so the
// result stays one clean prerelease tag rather than `beta.0-ansarac`.
function forkVersion(base, suffix) {
  assert(typeof base === 'string' && SEMVER.test(base) && !base.includes('+'),
    `Base version must be plain semver, got ${JSON.stringify(base)}`);
  assert(!base.includes(FORK_ID),
    `Base version ${base} is already a fork build; restore packages/happy-cli/package.json first`);
  const version = `${base}${base.includes('-') ? '.' : '-'}${FORK_ID}.${suffix}`;
  assert(SEMVER.test(version), `Not valid semver: ${version}`);
  return version;
}

// CI builds: the workflow run number, which only ever increases, so later
// builds of the same base sort higher (numeric prerelease identifiers compare
// numerically).
function ciVersion(base, runNumber) {
  assert(/^[1-9]\d*$/.test(String(runNumber)), `Run number must be a positive integer, got ${runNumber}`);
  return forkVersion(base, String(runNumber));
}

// From-source builds: `local.<sha>` (`.dirty` when the tree had changes). An
// all-digit short sha would be a numeric identifier, which semver forbids to
// start with 0, so such a sha gets a `g` prefix as in `git describe`.
function localVersion(base, sha, dirty) {
  assert(/^[0-9a-f]{4,40}$/.test(sha), `Not a git sha: ${sha}`);
  return forkVersion(base, `local.${/^\d+$/.test(sha) ? `g${sha}` : sha}${dirty ? '.dirty' : ''}`);
}

function readBaseVersion(packageJson = CLI_PACKAGE_JSON) {
  return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
}

// Same rewrite as `cli-release.cjs prepare`. Returns the original file text
// so a caller that must leave the tree clean can put it back byte for byte.
function stampManifest(packageJson, version) {
  assert(SEMVER.test(version) && version.includes(`${FORK_ID}.`), `Not a fork version: ${version}`);
  const original = fs.readFileSync(packageJson, 'utf8');
  const manifest = JSON.parse(original);
  manifest.version = version;
  checkManifest(manifest, version);
  fs.writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`);
  return original;
}

// Mirror of cli-release.cjs's smoke(), which is not exported. Keep in step
// with it: installed package shape, then --version / --help / daemon status
// against a throwaway HAPPY_HOME_DIR.
function smoke(prefix, version) {
  const root = path.join(prefix, 'node_modules', 'happy');
  checkPackage(root, version);
  for (const args of [['--version'], ['--help'], ['daemon', 'status']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/happy.mjs'), ...args], {
      cwd: prefix,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HAPPY_HOME_DIR: path.join(prefix, 'happy-home'),
        HAPPY_BOOT_AGENT: '0',
        HAPPY_EXPERIMENTAL: '0',
      },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `happy ${args.join(' ')} failed`);
    if (args[0] === '--version') checkVersionOutput(result.stdout, version);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'version') {
    console.log(ciVersion(readBaseVersion(), args[0]));
  } else if (command === 'prepare') {
    stampManifest(args[0], args[1]);
    console.log(`Stamped ${args[0]} with ${args[1]}`);
  } else if (command === 'check-package') {
    checkPackage(args[0], args[1]);
    console.log(`Package at ${args[0]} is a valid happy@${args[1]}`);
  } else if (command === 'smoke') {
    smoke(args[0], args[1]);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

module.exports = { FORK_ID, forkVersion, ciVersion, localVersion, readBaseVersion, stampManifest, checkVersionOutput };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
