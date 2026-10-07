#!/usr/bin/env node
// Exercises scripts/install-happy-cli.mjs end to end against a local HTTP
// server instead of GitHub Releases, so CI tests the installer with the exact
// tarball it is about to publish, before publishing it.
//
//   node .github/scripts/cli-installer-smoke.mjs <assets dir> <version> <work dir>
//
// <assets dir> holds happy-<version>.tgz and its .sha256. Installs into
// <work dir>/prefix (npm_config_prefix) with HAPPY_HOME_DIR=<work dir>/home,
// so nothing global on the machine changes. Two runs:
//   1. checksum mismatch: the installer must refuse and install nothing
//   2. good checksum: must install, and the CLI must report <version>
// Zero dependencies, Node >= 20, Linux/macOS/Windows.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [assetsDir, version, workDir] = process.argv.slice(2);
if (!assetsDir || !version || !workDir) {
  console.error('usage: cli-installer-smoke.mjs <assets dir> <version> <work dir>');
  process.exit(2);
}
const installer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/install-happy-cli.mjs');
const tarballName = `happy-${version}.tgz`;
const tarball = path.resolve(assetsDir, tarballName);
const checksum = fs.readFileSync(`${tarball}.sha256`, 'utf8');
const prefix = path.resolve(workDir, 'prefix');
const home = path.resolve(workDir, 'home');
fs.mkdirSync(prefix, { recursive: true });
fs.mkdirSync(home, { recursive: true });

// /good/<name> serves the real files; /bad/<name>.sha256 serves a checksum
// that cannot match.
const server = http.createServer((request, response) => {
  const [, kind, name] = request.url.split('/');
  if (name === tarballName) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(tarball).pipe(response);
  } else if (name === `${tarballName}.sha256`) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(kind === 'bad' ? `${'0'.repeat(64)}  ${tarballName}\n` : checksum);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function install(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installer, '--url', url], {
      env: { ...process.env, npm_config_prefix: prefix, HAPPY_HOME_DIR: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        out += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on('close', (code) => resolve({ code, out }));
  });
}

function check(condition, message) {
  if (!condition) {
    console.error(`\nnot ok - ${message}`);
    server.close();
    process.exit(1);
  }
  console.log(`\nok - ${message}`);
}

const installed = () => fs.existsSync(path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules', 'happy'));

console.log(`--- installer with a wrong checksum (${base}/bad/${tarballName})`);
const bad = await install(`${base}/bad/${tarballName}`);
check(bad.code !== 0 && bad.out.includes('Checksum mismatch'), 'installer refuses a tarball whose checksum does not match');
check(!installed(), 'nothing was installed after the mismatch');

console.log(`--- installer with the published checksum (${base}/good/${tarballName})`);
const good = await install(`${base}/good/${tarballName}`);
check(good.code === 0, 'installer exits 0');
check(installed(), `happy is installed under ${prefix}`);
check(good.out.split(/\r?\n/).includes(`happy version: ${version}`), `installed CLI reports happy version: ${version}`);

server.close();
