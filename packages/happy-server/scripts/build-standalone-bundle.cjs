#!/usr/bin/env node
'use strict';

/**
 * Builds the self-contained runtime directory for the standalone (self-host)
 * server: embedded PGlite, local file storage, no Postgres/Redis/S3. The root
 * Dockerfile copies this directory, and nothing else from the repo, into a bare
 * Node image.
 *
 *   node packages/happy-server/scripts/build-standalone-bundle.cjs \
 *       --out <dir> [--engine-target <prisma binary target>]
 *
 * Produces:
 *   <out>/standalone.mjs           bun bundle of sources/standalone.ts, every
 *                                  JS dependency inlined (fastify, socket.io,
 *                                  the generated Prisma client, PGlite, ...)
 *   <out>/pglite.wasm, pglite.data PGlite runtime; standalone.ts and db.ts load
 *                                  these from process.cwd()
 *   <out>/prisma/migrations/       read from process.cwd() by `migrate`
 *   <out>/libquery_engine.so.node  Prisma's native query engine for one
 *                                  platform; point PRISMA_QUERY_ENGINE_LIBRARY
 *                                  at it
 *
 * Run it with cwd = <out>:
 *   PRISMA_QUERY_ENGINE_LIBRARY=$PWD/libquery_engine.so.node node standalone.mjs migrate
 *   PRISMA_QUERY_ENGINE_LIBRARY=$PWD/libquery_engine.so.node node standalone.mjs serve
 *
 * The file must be called standalone.mjs: standalone.ts only runs its CLI when
 * argv[1] has one of a fixed set of basenames.
 *
 * What is left out, and why:
 *   - sharp: only reached from GitHub account connect (avatar resize), which
 *     needs GITHUB_CLIENT_ID/SECRET that self-hosters do not set. It stays a
 *     dynamic import, so only that path fails.
 *   - prisma CLI / @prisma/engines: migrate applies the SQL with PGlite itself.
 *   - redis: optional peer of the socket.io redis adapter, unused here.
 *
 * Prisma: bun inlines @prisma/client and the generated .prisma/client, but it
 * pins their __dirname to the build machine's paths, so Prisma's own engine
 * search looks in the wrong place. PRISMA_QUERY_ENGINE_LIBRARY bypasses that
 * search (same approach as happy-cli/scripts/bundle-server.cjs).
 *
 * --engine-target picks the engine platform (e.g. linux-musl-openssl-3.0.x for
 * Alpine, debian-openssl-3.0.x for glibc). If omitted, the engine `prisma
 * generate` produced for this machine is used, so building inside the same
 * base image as the runtime needs no flag. A target not installed locally is
 * downloaded with @prisma/fetch-engine at the engine version the generated
 * client was built against.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');
const ENGINE_FILE = 'libquery_engine.so.node';

const EXTERNALS = ['sharp', 'redis', 'prisma', '@prisma/engines'];

function fail(message) {
    console.error(`build-standalone-bundle: ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { out: null, engineTarget: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (!v || v.startsWith('--')) fail(`missing value for ${arg}`);
            return v;
        };
        if (arg === '--out') opts.out = path.resolve(value());
        else if (arg === '--engine-target') opts.engineTarget = value();
        else fail(`unknown argument ${arg}`);
    }
    if (!opts.out) fail('usage: build-standalone-bundle.cjs --out <dir> [--engine-target <target>]');
    return opts;
}

// Node-style node_modules walk. require.resolve('<pkg>/package.json') is not
// usable: several of these packages do not export ./package.json.
function packageDir(name, from = SERVER_DIR) {
    for (let dir = from; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
        if (path.dirname(dir) === dir) fail(`cannot find ${name} from ${from}`);
    }
}

// The bundle bakes pglite-prisma-adapter in, so the Bytes fix from
// patches/fix-pglite-prisma-bytes.cjs (applied by the root postinstall) must
// already be on disk. Without it Bytes columns break at runtime, not here.
function assertAdapterPatched() {
    const dir = packageDir('pglite-prisma-adapter');
    for (const file of ['dist/index.mjs', 'dist/index.cjs']) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        if (/Uint8Array\.from\(\s*\{\s*length:\s*hexString\.length/.test(source)) {
            fail(`${path.join(dir, file)} is unpatched; run node patches/fix-pglite-prisma-bytes.cjs first`);
        }
    }
}

function bundle(outDir) {
    const args = [
        'build', './sources/standalone.ts',
        '--target', 'node',
        '--format', 'esm',
        // keep-names: stack traces stay readable and costs ~1 KB.
        '--minify', '--keep-names',
        '--outfile', path.join(outDir, 'standalone.mjs'),
        ...EXTERNALS.flatMap(name => ['--external', name]),
    ];
    console.log(`$ bun ${args.join(' ')}`);
    // cwd = server package so bun picks up its tsconfig `@/*` paths.
    const result = spawnSync('bun', args, { cwd: SERVER_DIR, stdio: 'inherit' });
    if (result.error) fail(`could not run bun: ${result.error.message}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
}

function copyPgliteAssets(outDir) {
    const dist = path.join(packageDir('@electric-sql/pglite'), 'dist');
    for (const name of ['pglite.wasm', 'pglite.data']) {
        fs.copyFileSync(path.join(dist, name), path.join(outDir, name));
    }
}

function copyMigrations(outDir) {
    fs.cpSync(path.join(SERVER_DIR, 'prisma', 'migrations'), path.join(outDir, 'prisma', 'migrations'), { recursive: true });
}

function generatedClientDir() {
    // Resolve the way @prisma/client itself does (require('.prisma/client/default')).
    const clientDir = packageDir('@prisma/client');
    return path.dirname(require.resolve('.prisma/client/default', { paths: [clientDir] }));
}

async function copyEngine(outDir, requestedTarget) {
    const generated = generatedClientDir();
    const engines = packageDir('@prisma/engines', packageDir('prisma'));
    const local = [generated, engines].flatMap(dir =>
        fs.readdirSync(dir)
            .map(name => /^libquery_engine-(.+)\.so\.node$/.exec(name))
            .filter(Boolean)
            .map(m => ({ target: m[1], file: path.join(dir, m[0]) })));

    let target = requestedTarget;
    if (!target) {
        const targets = [...new Set(local.map(e => e.target))];
        if (targets.length !== 1) {
            fail(`found engines for ${targets.join(', ') || 'no platform'}; pass --engine-target`);
        }
        target = targets[0];
    }

    let source = local.find(e => e.target === target)?.file;
    if (!source) {
        const config = fs.readFileSync(path.join(generated, 'index.js'), 'utf8');
        const version = /"engineVersion":\s*"([0-9a-f]{40})"/.exec(config)?.[1];
        if (!version) fail(`could not read engineVersion from ${generated}/index.js`);
        console.log(`Downloading Prisma query engine ${version} for ${target}`);
        const { download, BinaryType } = require(require.resolve('@prisma/fetch-engine', { paths: [engines] }));
        const tmp = fs.mkdtempSync(path.join(outDir, '.engine-'));
        const paths = await download({
            binaries: { [BinaryType.QueryEngineLibrary]: tmp },
            binaryTargets: [target],
            version,
        });
        source = paths[BinaryType.QueryEngineLibrary]?.[target];
        if (!source || !fs.existsSync(source)) fail(`download of the ${target} engine produced nothing`);
        fs.copyFileSync(source, path.join(outDir, ENGINE_FILE));
        fs.rmSync(tmp, { recursive: true, force: true });
    } else {
        fs.copyFileSync(source, path.join(outDir, ENGINE_FILE));
    }
    return target;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.out === REPO_ROOT || opts.out === SERVER_DIR) fail(`refusing to clear ${opts.out}`);

    assertAdapterPatched();
    fs.rmSync(opts.out, { recursive: true, force: true });
    fs.mkdirSync(opts.out, { recursive: true });

    bundle(opts.out);
    copyPgliteAssets(opts.out);
    copyMigrations(opts.out);
    const target = await copyEngine(opts.out, opts.engineTarget);

    console.log(`\nStandalone runtime written to ${opts.out} (Prisma engine: ${target})`);
    for (const name of fs.readdirSync(opts.out).sort()) {
        const stat = fs.statSync(path.join(opts.out, name));
        console.log(`  ${name}${stat.isDirectory() ? '/' : `  ${(stat.size / 1024 / 1024).toFixed(1)} MB`}`);
    }
}

main().catch(e => fail(e?.stack || String(e)));
