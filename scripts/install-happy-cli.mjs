#!/usr/bin/env node
// Install or upgrade this fork's happy CLI (Ansarac/happy) on Linux, macOS or
// Windows. Node >= 20, no dependencies. See docs/install-fork-cli.md.
//
//   node scripts/install-happy-cli.mjs                    latest CI build (GitHub release cli-latest)
//   node scripts/install-happy-cli.mjs --version <v>      a specific CI build (release cli-v<v>)
//   node scripts/install-happy-cli.mjs --url <tgz url>    any tarball with a <url>.sha256 next to it
//   node scripts/install-happy-cli.mjs --from-source      build this checkout and install that
//
// Always installs a packed tarball with `npm install -g`, never `npm link`:
// npm dedupes the tarball's dependencies into one tree, while running from a
// pnpm (node-linker=hoisted) checkout can leave two Reacts and crash ink UIs.
//
// Default mode downloads with Node's fetch, which only goes through
// HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1. Behind a proxy the script re-runs
// itself with that set (Node >= 22.21 / 24). The tarball is checked against
// the published .sha256 before npm sees it, and npm installs the verified
// local file, so a proxy or middlebox answering with an HTML page fails the
// check instead of being installed.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_REPO = 'Ansarac/happy';
const isWindows = process.platform === 'win32';
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

const HELP = `Install this fork's happy CLI globally with npm.

Usage: node install-happy-cli.mjs [options]

  (no options)        Install the latest CI build:
                      https://github.com/${DEFAULT_REPO}/releases/download/cli-latest/happy-cli.tgz
  --version <v>       Install CI build <v> (release cli-v<v>), e.g. 1.2.5-ansarac.12
  --url <url>         Install the tarball at <url>; its checksum must be at <url>.sha256
  --repo <owner/name> Take releases from another GitHub repo (default ${DEFAULT_REPO})
  --from-source       Build the checkout this script lives in and install that
  --skip-install      With --from-source: skip \`pnpm install --frozen-lockfile\`
  --dry-run           Print what would happen; change nothing
  -h, --help          Show this help

npm installs into its configured global prefix (\`npm prefix -g\`); set
npm_config_prefix to install somewhere else. A running happy daemon (found via
$HAPPY_HOME_DIR or ~/.happy) is stopped first and must be started again after.`;

function log(message = '') {
  console.log(message);
}

function step(message) {
  log(`\n==> ${message}`);
}

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

// --- process helpers --------------------------------------------------------

// npm, pnpm and corepack are .cmd shims on Windows, which Node only spawns
// through a shell (CVE-2024-27980). cmd.exe needs paths with spaces quoted.
function quoteForCmd(arg) {
  if (arg.includes('"')) throw fail(`Cannot pass an argument containing a double quote on Windows: ${arg}`);
  return /^[\w\-.:\\/=@+,]+$/.test(arg) ? arg : `"${arg}"`;
}

function spawnArgs(command, args, options) {
  const viaShell = isWindows && command !== process.execPath && command !== 'git';
  return viaShell
    ? [[command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true }]
    : [command, args, options];
}

// Short captured commands (versions, prefixes).
function run(command, args, { cwd, env, capture = false, timeout } = {}) {
  const result = spawnSync(...spawnArgs(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    // Captured runs get a closed stdin pipe, so nothing can wait on input.
    stdio: capture ? 'pipe' : 'inherit',
    timeout,
    windowsHide: true,
  }));
  return { ...result, ok: !result.error && result.status === 0 };
}

// Long-running steps (pnpm, npm install). Asynchronous so that a signal
// handler can run while they do: under spawnSync a signal sent to this
// process alone waits until the step ends, and the script carries on.
let currentChild = null;

function mustRun(command, args, { cwd, env } = {}) {
  const display = [command, ...args].join(' ');
  log(`$ ${display}`);
  return new Promise((resolve, reject) => {
    const child = spawn(...spawnArgs(command, args, {
      cwd, env: env ?? process.env, stdio: 'inherit', windowsHide: true,
    }));
    currentChild = child;
    child.on('error', (error) => {
      currentChild = null;
      reject(fail(`Command failed (${error.message}): ${display}`));
    });
    child.on('close', (code, signal) => {
      currentChild = null;
      if (code === 0) resolve();
      else reject(fail(`Command failed (${signal ? `killed by ${signal}` : `exit code ${code}`}): ${display}`));
    });
  });
}

function output(command, args, options) {
  const result = run(command, args, { ...options, capture: true });
  return result.ok ? result.stdout.trim() : null;
}

// --- npm / happy locations ----------------------------------------------------

function npmGlobalPrefix() {
  const prefix = output('npm', ['prefix', '-g']);
  if (!prefix) throw fail('Could not run `npm prefix -g`. Is npm installed and on PATH?');
  return prefix;
}

function happyShim(prefix) {
  return isWindows ? path.join(prefix, 'happy.cmd') : path.join(prefix, 'bin', 'happy');
}

// First `happy` on PATH, to warn when it is not the one just installed (an
// old `npm link`, a second Node install, nvm switching versions...).
function happyOnPath() {
  const names = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => `happy${ext.toLowerCase()}`)
    : ['happy'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function samePath(a, b) {
  const norm = (p) => {
    let resolved = path.resolve(p);
    try { resolved = fs.realpathSync(resolved); } catch {}
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

// Runs the installed CLI the way the release smoke test does: against an
// empty HAPPY_HOME_DIR. `happy --version` does not exit after printing; with
// credentials present it goes on to replace a daemon of another version,
// create a session on the server and launch claude. An empty home has no
// credentials, so it prints and stops.
function installedVersion(prefix) {
  const shim = happyShim(prefix);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-version-'));
  try {
    const result = run(shim, ['--version'], {
      capture: true,
      timeout: 60_000,
      env: { ...process.env, HAPPY_HOME_DIR: home, HAPPY_BOOT_AGENT: '0', HAPPY_EXPERIMENTAL: '0' },
    });
    const line = `${result.stdout || ''}`.split(/\r?\n/).find((l) => l.startsWith('happy version: '));
    if (!line) {
      throw fail(`${shim} --version did not report a version:\n${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`);
    }
    return line.slice('happy version: '.length).trim();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- daemon -----------------------------------------------------------------

function happyHome() {
  const fromEnv = process.env.HAPPY_HOME_DIR;
  return fromEnv ? fromEnv.replace(/^~/, os.homedir()) : path.join(os.homedir(), '.happy');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function runningDaemon() {
  const stateFile = path.join(happyHome(), 'daemon.state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
  return Number.isInteger(state?.pid) && isAlive(state.pid) ? { ...state, stateFile } : null;
}

// The same request `happy daemon stop` sends. Done here rather than through
// the old `happy`, which may be broken or missing. A fresh http.Agent so an
// env-configured proxy is never applied to 127.0.0.1.
function postStop(port) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port, path: '/stop', method: 'POST',
      headers: { 'content-type': 'application/json' },
      agent: new http.Agent(), timeout: 5000,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode === 200));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end('{}');
  });
}

async function stopDaemon(daemon, dryRun) {
  if (!daemon) {
    log('No running happy daemon found.');
    return;
  }
  log(`happy daemon is running: pid ${daemon.pid}, version ${daemon.startedWithCliVersion ?? 'unknown'} (${daemon.stateFile})`);
  if (dryRun) {
    log('Would stop it before installing (sessions keep running).');
    return;
  }
  log('Stopping it so npm can replace its files (sessions keep running).');
  if (daemon.httpPort) await postStop(daemon.httpPort);
  for (let waited = 0; waited < 10_000 && isAlive(daemon.pid); waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (isAlive(daemon.pid)) {
    throw fail(`The happy daemon (pid ${daemon.pid}) did not stop. Stop it with \`happy daemon stop\` `
      + '(or your service manager, e.g. `systemctl --user stop happy-daemon`) and run this again.');
  }
  log('Daemon stopped.');
}

// --- default mode: CI build from GitHub Releases ------------------------------

function proxyConfigured() {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => process.env[name]);
}

function nodeHasEnvProxy() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

function respawnWithEnvProxy() {
  const result = spawnSync(process.execPath, [...process.execArgv, scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(result.status ?? 1);
}

async function get(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'happy-fork-installer' } });
  } catch (error) {
    throw fail(`Download failed: ${url}\n${error.cause?.message ?? error.message}${proxyHint()}`);
  }
  if (!response.ok) {
    const hint = response.status === 404
      ? '\nNo such release asset. Check the version (releases are named cli-v<version>) or that the CLI Package workflow has published one.'
      : proxyHint();
    throw fail(`Download failed: ${url} -> HTTP ${response.status} ${response.statusText}${hint}`);
  }
  return response;
}

function proxyHint() {
  if (!proxyConfigured()) return '';
  if (!nodeHasEnvProxy()) {
    return `\nA proxy is configured, but Node ${process.versions.node} cannot send fetch() through it. `
      + 'Use Node >= 22.21 or 24, or install with npm directly (it honours the proxy): '
      + 'npm install -g <tarball url>';
  }
  return '\nA proxy is configured and NODE_USE_ENV_PROXY=1 is set; check HTTPS_PROXY / NO_PROXY and, '
    + 'for TLS-inspecting proxies, NODE_EXTRA_CA_CERTS.';
}

async function downloadChecksum(url) {
  const text = await (await get(url)).text();
  const match = /^([0-9a-f]{64})(?:\s|$)/i.exec(text.trim());
  if (!match) {
    throw fail(`${url} is not a sha256 file (got ${JSON.stringify(text.slice(0, 80))}...). `
      + `A proxy or captive page answering instead of GitHub looks like this.${proxyHint()}`);
  }
  return match[1].toLowerCase();
}

async function downloadFile(url, destination) {
  const response = await get(url);
  const hash = createHash('sha256');
  const out = fs.createWriteStream(destination);
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
  } finally {
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  }
  return hash.digest('hex');
}

function releaseUrl(options) {
  if (options.url) return options.url;
  const repo = options.repo ?? DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail(`--repo must be owner/name, got ${repo}`);
  const base = `https://github.com/${repo}/releases/download`;
  if (!options.version) return `${base}/cli-latest/happy-cli.tgz`;
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(options.version)) {
    throw fail(`--version must look like 1.2.5-ansarac.12, got ${options.version}`);
  }
  return `${base}/cli-v${options.version}/happy-${options.version}.tgz`;
}

async function fromRelease(options) {
  const url = releaseUrl(options);
  const checksumUrl = `${url}.sha256`;
  const prefix = npmGlobalPrefix();
  log(`Tarball:   ${url}`);
  log(`Checksum:  ${checksumUrl}`);
  log(`npm prefix: ${prefix}`);
  const daemon = runningDaemon();

  if (options['dry-run']) {
    step('Dry run: would download and verify');
    log(`Would download ${checksumUrl} and ${url} to a temp dir and compare sha256.`);
    if (proxyConfigured()) log(`A proxy is configured; downloads would run with NODE_USE_ENV_PROXY=1.`);
    await stopDaemon(daemon, true);
    log(`Would run: npm install -g <verified tarball> --no-audit --no-fund (into ${prefix})`);
    return { prefix, daemon, expected: options.version };
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-'));
  try {
    step('Downloading');
    const expected = await downloadChecksum(checksumUrl);
    const tarball = path.join(temp, path.basename(new URL(url).pathname) || 'happy-cli.tgz');
    const actual = await downloadFile(url, tarball);
    if (actual !== expected) {
      throw fail(`Checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}\n`
        + 'If this is cli-latest, a new build may have been published mid-download: run again, or pin --version.');
    }
    log(`sha256 ${actual} OK (${(fs.statSync(tarball).size / 1e6).toFixed(1)} MB)`);

    step('Installing');
    await stopDaemon(daemon, false);
    await mustRun('npm', ['install', '-g', tarball, '--no-audit', '--no-fund']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { prefix, daemon, expected: options.version };
}

// --- --from-source --------------------------------------------------------------

// pnpm at the exact packageManager version if it is on PATH, else corepack
// (which reads packageManager itself), else whatever pnpm there is, with a
// warning. Never fails just because pnpm is not installed.
function resolvePnpm() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const wanted = /^pnpm@([^+]+)/.exec(manifest.packageManager ?? '')?.[1] ?? null;
  const onPath = output('pnpm', ['--version'], { cwd: repoRoot });
  if (onPath && (!wanted || onPath === wanted)) return { command: 'pnpm', prefixArgs: [], version: onPath };
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  const viaCorepack = output('corepack', ['pnpm', '--version'], { cwd: repoRoot, env });
  if (viaCorepack) return { command: 'corepack', prefixArgs: ['pnpm'], version: viaCorepack, env };
  if (onPath) {
    log(`warning: pnpm ${onPath} is on PATH but this repo pins pnpm ${wanted}, and corepack is unavailable. Trying anyway.`);
    return { command: 'pnpm', prefixArgs: [], version: onPath };
  }
  throw fail(`Neither pnpm nor corepack is available. Install pnpm ${wanted ?? ''} (npm install -g pnpm@${wanted ?? 'latest'}) `
    + 'or corepack (npm install -g corepack), then run this again.');
}

async function fromSource(options) {
  const forkPackage = createRequire(import.meta.url)('./fork-cli-package.cjs');
  const cliManifest = path.join(repoRoot, 'packages', 'happy-cli', 'package.json');
  if (!fs.existsSync(cliManifest) || !fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) {
    throw fail(`${repoRoot} does not look like a happy checkout.`);
  }
  const sha = output('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  if (!sha) throw fail(`Could not read the git commit of ${repoRoot}. --from-source needs a git checkout and git on PATH.`);
  const dirty = output('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot }) !== '';
  let version;
  try {
    version = forkPackage.localVersion(forkPackage.readBaseVersion(cliManifest), sha, dirty);
  } catch (error) {
    throw fail(`${error.message}\n(git checkout -- packages/happy-cli/package.json restores it.)`);
  }
  const pnpm = resolvePnpm();
  const pnpmRun = (args) => mustRun(pnpm.command, [...pnpm.prefixArgs, ...args], { cwd: repoRoot, env: pnpm.env });
  const prefix = npmGlobalPrefix();
  const daemon = runningDaemon();

  log(`Checkout:  ${repoRoot} @ ${sha}${dirty ? ' (uncommitted changes)' : ''}`);
  log(`Version:   ${version}`);
  log(`pnpm:      ${pnpm.version} (${[pnpm.command, ...pnpm.prefixArgs].join(' ')})`);
  log(`npm prefix: ${prefix}`);

  if (options['dry-run']) {
    step('Dry run: would build and install');
    const p = [pnpm.command, ...pnpm.prefixArgs].join(' ');
    if (!options['skip-install']) log(`Would run: ${p} install --frozen-lockfile`);
    log(`Would run: ${p} --filter @slopus/happy-wire build`);
    log(`Would stamp packages/happy-cli/package.json with ${version} (restored afterwards)`);
    log(`Would run: ${p} --filter happy build`);
    log(`Would run: ${p} --filter happy pack --pack-destination <temp dir>`);
    await stopDaemon(daemon, true);
    log(`Would run: npm install -g <temp dir>/happy-${version}.tgz --no-audit --no-fund (into ${prefix})`);
    return { prefix, daemon, expected: version };
  }

  if (!options['skip-install']) {
    step('Installing workspace dependencies');
    await pnpmRun(['install', '--frozen-lockfile']);
  }
  step('Building happy-wire');
  await pnpmRun(['--filter', '@slopus/happy-wire', '--fail-if-no-match', 'build']);

  // The version is compiled into the bundle (configuration.ts imports
  // package.json), so it has to be stamped before building. The original
  // bytes go back on every exit path, signals included, so the checkout is
  // left as it was found.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-'));
  let original = null;
  const restore = () => {
    if (original === null) return;
    fs.writeFileSync(cliManifest, original);
    original = null;
    log('Restored packages/happy-cli/package.json');
  };
  const onSignal = (signal) => {
    restore();
    currentChild?.kill(signal);
    fs.rmSync(temp, { recursive: true, force: true });
    console.error(`\nInterrupted (${signal}); nothing was installed.`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].filter((s) => !(isWindows && s === 'SIGHUP'));
  for (const signal of signals) process.on(signal, onSignal);
  process.on('exit', restore);
  let tarball;
  try {
    step(`Stamping version ${version}`);
    original = forkPackage.stampManifest(cliManifest, version);
    step('Building happy CLI');
    await pnpmRun(['--filter', 'happy', '--fail-if-no-match', 'build']);
    step('Packing');
    await pnpmRun(['--filter', 'happy', '--fail-if-no-match', 'pack', '--pack-destination', temp]);
    tarball = path.join(temp, `happy-${version}.tgz`);
    if (!fs.existsSync(tarball)) throw fail(`pnpm pack did not produce ${tarball}`);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  } finally {
    restore();
    for (const signal of signals) process.off(signal, onSignal);
    process.off('exit', restore);
  }

  try {
    step('Installing');
    await stopDaemon(daemon, false);
    await mustRun('npm', ['install', '-g', tarball, '--no-audit', '--no-fund']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { prefix, daemon, expected: version };
}

// --- main ---------------------------------------------------------------------

function report({ prefix, daemon, expected }) {
  step('Done');
  const shim = happyShim(prefix);
  const version = installedVersion(prefix);
  log(`${shim} --version`);
  log(`happy version: ${version}`);
  if (expected && version !== expected) {
    throw fail(`Installed CLI reports ${version}, expected ${expected}.`);
  }
  const first = happyOnPath();
  if (!first) {
    log(`\nnote: \`happy\` is not on PATH. Add ${path.dirname(shim)} to PATH.`);
  } else if (!samePath(path.dirname(first), path.dirname(shim))) {
    log(`\nwarning: \`happy\` on PATH is ${first}, not the one just installed (${shim}).`
      + `\nRemove the other one or put ${path.dirname(shim)} first on PATH.`);
  }
  log(daemon
    ? '\nThe happy daemon was stopped. Start it again with:  happy daemon start'
    : '\nIf you run the happy daemon, (re)start it so it picks up this version:  happy daemon start');
  log('If a service manager runs the daemon (systemd, launchd, a Windows task), restart it there instead,\n'
    + 'e.g. `systemctl --user restart happy-daemon`, and check that its ExecStart points at this install.');
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      'from-source': { type: 'boolean' },
      'skip-install': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      version: { type: 'string' },
      url: { type: 'string' },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (options.help) {
    log(HELP);
    return;
  }
  if (options['from-source'] && (options.version || options.url || options.repo)) {
    throw fail('--from-source cannot be combined with --version, --url or --repo.');
  }
  if (options.url && (options.version || options.repo)) {
    throw fail('--url cannot be combined with --version or --repo.');
  }
  if (options['skip-install'] && !options['from-source']) {
    throw fail('--skip-install only applies to --from-source.');
  }
  if (!options['from-source'] && !options['dry-run'] && proxyConfigured()
      && process.env.NODE_USE_ENV_PROXY !== '1' && nodeHasEnvProxy()) {
    respawnWithEnvProxy();
  }
  const result = options['from-source'] ? await fromSource(options) : await fromRelease(options);
  if (options['dry-run']) {
    log('\nDry run: nothing was changed.');
    return;
  }
  report(result);
}

main().catch((error) => {
  console.error(`\nerror: ${error.userFacing ? error.message : error.stack ?? error}`);
  process.exitCode = 1;
});
