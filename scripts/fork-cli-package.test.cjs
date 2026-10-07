const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { forkVersion, ciVersion, localVersion, stampManifest } = require('./fork-cli-package.cjs');

test('CI builds append the run number and sort numerically', () => {
  assert.equal(ciVersion('1.2.5', 12), '1.2.5-ansarac.12');
  assert.equal(ciVersion('1.2.5', '7'), '1.2.5-ansarac.7');
  // A beta base keeps a single prerelease tag instead of `beta.0-ansarac`.
  assert.equal(ciVersion('1.2.5-beta.0', 3), '1.2.5-beta.0.ansarac.3');
  for (const bad of ['0', '012', '-1', '1.5', '', '1; rm -rf /', undefined]) {
    assert.throws(() => ciVersion('1.2.5', bad), `run number ${bad}`);
  }
});

test('local builds carry the short sha and a dirty marker', () => {
  assert.equal(localVersion('1.2.5', 'a41165b1', false), '1.2.5-ansarac.local.a41165b1');
  assert.equal(localVersion('1.2.5', 'a41165b1', true), '1.2.5-ansarac.local.a41165b1.dirty');
  // All-digit sha with a leading zero is not a valid numeric identifier.
  assert.equal(localVersion('1.2.5', '0123456', false), '1.2.5-ansarac.local.g0123456');
  assert.throws(() => localVersion('1.2.5', 'HEAD', false));
});

test('refuses a base that is not plain semver or already a fork build', () => {
  for (const base of ['v1.2.5', '1.2', '01.2.5', '1.2.5+meta', '1.2.5-ansarac.3', '', undefined]) {
    assert.throws(() => forkVersion(base, '1'), `base ${base}`);
  }
});

test('stamping rewrites only the version and returns the original text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cli-package-'));
  const file = path.join(dir, 'package.json');
  const original = `${JSON.stringify({
    name: 'happy', version: '1.2.5',
    repository: { type: 'git', url: 'https://github.com/slopus/happy' },
    devDependencies: { '@slopus/happy-wire': 'workspace:*' },
  }, null, 2)}\n`;
  fs.writeFileSync(file, original);
  assert.equal(stampManifest(file, '1.2.5-ansarac.4'), original);
  const stamped = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(stamped).version, '1.2.5-ansarac.4');
  assert.equal(stamped, original.replace('"1.2.5"', '"1.2.5-ansarac.4"'));
  assert.throws(() => stampManifest(file, '1.2.6'), /fork version/);
  fs.rmSync(dir, { recursive: true, force: true });
});
