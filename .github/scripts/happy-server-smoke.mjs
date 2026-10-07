#!/usr/bin/env node
// Smoke test for a running happy-server (the standalone image, or `standalone.ts serve`).
//
//   node .github/scripts/happy-server-smoke.mjs <baseUrl>
//        [--expect-registration=open|closed] [--state-file=<path>] [--wait=<seconds>]
//
// Zero dependencies on purpose: CI runs it on a bare runner against a container,
// so it uses only Node >= 20 built-ins (global fetch, node:crypto Ed25519, and
// global WebSocket when present). Prints one TAP-style line per check and exits
// non-zero at the first failure.
//
// --state-file keeps the signing keypair, account id and token between runs.
// CI runs this, restarts the container, and runs it again with the same file:
// the second run must log the same key into the same account, and the token
// issued before the restart must still be accepted — that is what proves the
// data volume and HANDY_MASTER_SECRET survive a restart. With
// --expect-registration=closed the state file must come from an earlier open
// run, because a closed server cannot mint the account the other checks need.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// --- CLI ---------------------------------------------------------------------

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
    args.filter((a) => a.startsWith('--')).map((a) => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.join('=')];
    }),
);
if (positional.length !== 1) {
    console.error('usage: happy-server-smoke.mjs <baseUrl> [--expect-registration=open|closed] [--state-file=<path>] [--wait=<seconds>]');
    process.exit(2);
}
const baseUrl = positional[0].replace(/\/+$/, '');
const expectRegistration = flags['expect-registration'] || 'open';
if (expectRegistration !== 'open' && expectRegistration !== 'closed') {
    console.error(`--expect-registration must be 'open' or 'closed', got '${expectRegistration}'`);
    process.exit(2);
}
const stateFile = flags['state-file'] || null;
const waitSeconds = Number(flags.wait || 90);

// Socket.IO path from packages/happy-server/sources/app/api/socketConfig.ts.
const SOCKET_PATH = '/v1/updates/';
const REQUEST_TIMEOUT_MS = 15_000;

// --- Reporting ---------------------------------------------------------------

let checkCount = 0;

class CheckFailure extends Error {}

function ok(name) {
    checkCount++;
    console.log(`ok ${checkCount} - ${name}`);
}

function skip(name, reason) {
    checkCount++;
    console.log(`ok ${checkCount} - ${name} # SKIP ${reason}`);
}

// Runs one check. The body throws (or calls fail) with a message that should
// say what was expected and what came back, since that line is all CI shows.
async function check(name, body) {
    try {
        const result = await body();
        ok(name);
        return result;
    } catch (e) {
        checkCount++;
        console.log(`not ok ${checkCount} - ${name}`);
        console.log(`  # ${e instanceof CheckFailure ? e.message : (e?.stack || e)}`.replace(/\n/g, '\n  # '));
        process.exit(1);
    }
}

function fail(message) {
    throw new CheckFailure(message);
}

function assert(condition, message) {
    if (!condition) fail(message);
}

// --- HTTP helpers --------------------------------------------------------------

async function http(method, path, { body, token, headers = {} } = {}) {
    const res = await fetch(baseUrl + path, {
        method,
        headers: {
            ...(body !== undefined ? { 'content-type': typeof body === 'string' ? 'text/plain;charset=UTF-8' : 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
}

function describe(res) {
    return `HTTP ${res.status} ${res.text.slice(0, 300)}`;
}

// --- Keys ----------------------------------------------------------------------
//
// POST /v1/auth verifies with tweetnacl.sign.detached.verify, which is plain
// Ed25519 over the raw challenge bytes, so node:crypto's sign(null, ...) is
// wire-compatible. Keys, challenge and signature travel as standard (padded)
// base64, which is what privacy-kit's decodeBase64 defaults to.

function rawPublicKey(publicKey) {
    return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
}

function newKeypair() {
    const { privateKey } = generateKeyPairSync('ed25519');
    return keypairFrom(privateKey);
}

function keypairFrom(privateKey) {
    const publicKey = createPublicKey(privateKey);
    return {
        privateKey,
        publicKeyB64: rawPublicKey(publicKey).toString('base64'),
        pkcs8B64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    };
}

function authBody(keypair, { tamper = false } = {}) {
    const challenge = randomBytes(32);
    const signature = sign(null, challenge, keypair.privateKey);
    if (tamper) signature[0] ^= 0x01;
    return {
        publicKey: keypair.publicKeyB64,
        challenge: challenge.toString('base64'),
        signature: signature.toString('base64'),
    };
}

// --- Engine.IO v4 / Socket.IO v5 ------------------------------------------------
//
// Just enough of the protocol to prove the realtime path, without socket.io-client.
// Engine.IO packet types: 0 open, 1 close, 2 ping, 3 pong, 4 message. A Socket.IO
// packet rides inside a message: 0 CONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR.
// So "40{...}" is CONNECT, "44{...}" is CONNECT_ERROR, "420[..]" is EVENT with
// ack id 0 and "430[..]" is its ACK. Polling payloads join packets with \x1e.

const socketAuth = (token) => JSON.stringify({ token, clientType: 'user-scoped' });

function parseOpen(packet, where) {
    assert(packet?.startsWith('0{'), `expected Engine.IO open packet from ${where}, got ${JSON.stringify(packet?.slice(0, 200))}`);
    const open = JSON.parse(packet.slice(1));
    assert(typeof open.sid === 'string', `open packet has no sid: ${packet}`);
    return open;
}

// Long-polls until a packet matching `want` arrives. Answers server pings so a
// slow CI box cannot get the session dropped mid-check.
async function pollFor(sid, want, what) {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const seen = [];
    while (Date.now() < deadline) {
        const res = await http('GET', `${SOCKET_PATH}?EIO=4&transport=polling&sid=${sid}`);
        assert(res.status === 200, `polling GET for ${what}: ${describe(res)}`);
        for (const packet of res.text.split('\x1e')) {
            if (want(packet)) return packet;
            seen.push(packet);
            if (packet === '2') await http('POST', `${SOCKET_PATH}?EIO=4&transport=polling&sid=${sid}`, { body: '3' });
            if (packet === '1') fail(`server closed the polling session while waiting for ${what}; saw ${JSON.stringify(seen)}`);
            if (packet.startsWith('44')) fail(`Socket.IO CONNECT_ERROR while waiting for ${what}: ${packet}`);
        }
    }
    fail(`timed out waiting for ${what}; saw ${JSON.stringify(seen)}`);
}

async function pollingConnect(token) {
    const open = await http('GET', `${SOCKET_PATH}?EIO=4&transport=polling`);
    assert(open.status === 200, `Engine.IO handshake at ${SOCKET_PATH}: ${describe(open)}`);
    const { sid } = parseOpen(open.text, 'polling handshake');
    const post = await http('POST', `${SOCKET_PATH}?EIO=4&transport=polling&sid=${sid}`, { body: `40${socketAuth(token)}` });
    assert(post.status === 200 && post.text === 'ok', `POST of Socket.IO CONNECT: ${describe(post)}`);
    const reply = await pollFor(sid, (p) => p.startsWith('40') || p.startsWith('44'), 'CONNECT reply');
    return { sid, reply };
}

async function pollingClose(sid) {
    await http('POST', `${SOCKET_PATH}?EIO=4&transport=polling&sid=${sid}`, { body: '1' }).catch(() => {});
}

// WebSocket transport straight away (no polling upgrade), which is exactly how
// the app and CLI connect (transports: ['websocket']). This is the check that
// catches a reverse proxy that drops the Upgrade/Connection headers.
function websocketPing(token) {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `${SOCKET_PATH}?EIO=4&transport=websocket`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const seen = [];
        let stage = 'open';
        const timer = setTimeout(() => {
            ws.close();
            reject(new CheckFailure(`timed out at stage '${stage}' on ${wsUrl}; saw ${JSON.stringify(seen)}`));
        }, REQUEST_TIMEOUT_MS);
        const done = (err, value) => {
            clearTimeout(timer);
            try { ws.close(); } catch { /* already closed */ }
            err ? reject(err) : resolve(value);
        };
        ws.onerror = (e) => done(new CheckFailure(`WebSocket error at stage '${stage}' on ${wsUrl}: ${e.message || e.error?.message || 'connection failed'}`));
        ws.onclose = (e) => done(new CheckFailure(`WebSocket closed at stage '${stage}' (code ${e.code}); saw ${JSON.stringify(seen)}`));
        ws.onmessage = ({ data }) => {
            const packet = String(data);
            seen.push(packet);
            if (packet === '2') { ws.send('3'); return; }
            try {
                if (stage === 'open') {
                    parseOpen(packet, 'websocket handshake');
                    stage = 'connect';
                    ws.send(`40${socketAuth(token)}`);
                } else if (stage === 'connect') {
                    assert(!packet.startsWith('44'), `Socket.IO CONNECT_ERROR over websocket: ${packet}`);
                    if (!packet.startsWith('40')) return;
                    stage = 'ack';
                    ws.send('420["ping"]');
                } else if (stage === 'ack' && packet.startsWith('430')) {
                    done(null, packet);
                }
            } catch (e) {
                done(e);
            }
        };
    });
}

// --- State file ----------------------------------------------------------------

function loadState() {
    if (!stateFile || !existsSync(stateFile)) return null;
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const privateKey = createPrivateKey({ key: Buffer.from(state.secretKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const keypair = keypairFrom(privateKey);
    if (keypair.publicKeyB64 !== state.publicKey) throw new Error(`state file ${stateFile} is inconsistent: stored publicKey does not match the private key`);
    return { ...state, keypair };
}

function saveState(keypair, accountId, token) {
    if (!stateFile) return;
    writeFileSync(stateFile, JSON.stringify({
        secretKeyPkcs8: keypair.pkcs8B64,
        publicKey: keypair.publicKeyB64,
        accountId,
        token,
        baseUrl,
        updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 });
}

// --- Checks ----------------------------------------------------------------------

async function main() {
    const prior = loadState();
    console.log(`# happy-server smoke: ${baseUrl}, registration=${expectRegistration}, state=${stateFile ? (prior ? `reusing ${stateFile}` : `new ${stateFile}`) : 'none'}`);

    if (expectRegistration === 'closed' && !prior) {
        console.log('not ok - --expect-registration=closed needs --state-file from an earlier open run (a closed server cannot create the account the authenticated checks use)');
        process.exit(1);
    }

    // 1. Health. /health runs `SELECT 1`, so it only answers ok once the API is
    //    listening AND the database is reachable. Retried so CI can call this
    //    right after `docker run`.
    await check('GET /health returns status ok', async () => {
        const deadline = Date.now() + waitSeconds * 1000;
        let last = 'no attempt';
        while (true) {
            try {
                const res = await http('GET', '/health');
                if (res.status === 200 && res.json?.status === 'ok') return;
                last = describe(res);
            } catch (e) {
                last = e.cause?.code || e.cause?.message || e.message;
            }
            if (Date.now() > deadline) fail(`not healthy after ${waitSeconds}s; last result: ${last}`);
            await new Promise((r) => setTimeout(r, 1000));
        }
    });

    // 2. An unauthenticated route that goes through Prisma (terminalAuthRequest
    //    lookup), so a missing or unmigrated table fails here rather than later.
    await check('GET /v1/auth/request/status answers from the database', async () => {
        const zeroKey = Buffer.alloc(32).toString('base64');
        const res = await http('GET', `/v1/auth/request/status?publicKey=${encodeURIComponent(zeroKey)}`);
        assert(res.status === 200 && typeof res.json?.status === 'string', `expected 200 with a status field, got ${describe(res)}`);
    });

    // 3. Login / signup. The tampered-signature probe guards against the smoke
    //    test passing against a server that accepts anything.
    const probeKey = newKeypair();
    await check('POST /v1/auth rejects a tampered signature with 401', async () => {
        const res = await http('POST', '/v1/auth', { body: authBody(probeKey, { tamper: true }) });
        assert(res.status === 401, `expected 401, got ${describe(res)}`);
    });

    const keypair = prior?.keypair ?? newKeypair();
    let token;
    if (expectRegistration === 'open') {
        token = await check(`POST /v1/auth with ${prior ? 'the saved' : 'a new'} key returns a token (registration open)`, async () => {
            const res = await http('POST', '/v1/auth', { body: authBody(keypair) });
            assert(res.status === 200 && typeof res.json?.token === 'string', `expected 200 with a token, got ${describe(res)}`);
            return res.json.token;
        });
    } else {
        await check('POST /v1/auth with a new key is refused with 403 (registration closed)', async () => {
            const res = await http('POST', '/v1/auth', { body: authBody(probeKey) });
            assert(res.status === 403, `expected 403, got ${describe(res)}`);
        });
        token = await check('POST /v1/auth with the already-registered key still logs in (registration closed)', async () => {
            const res = await http('POST', '/v1/auth', { body: authBody(keypair) });
            assert(res.status === 200 && typeof res.json?.token === 'string', `expected 200 with a token, got ${describe(res)}`);
            return res.json.token;
        });
    }

    // 4. Authenticated REST against the database.
    await check('GET /v1/account/profile rejects a bogus bearer token with 401', async () => {
        const res = await http('GET', '/v1/account/profile', { token: 'not-a-real-token' });
        assert(res.status === 401, `expected 401, got ${describe(res)}`);
    });

    const accountId = await check('GET /v1/account/profile returns the account', async () => {
        const res = await http('GET', '/v1/account/profile', { token });
        assert(res.status === 200 && typeof res.json?.id === 'string' && res.json.id.length > 0, `expected 200 with an id, got ${describe(res)}`);
        return res.json.id;
    });

    await check('GET /v1/sessions lists sessions', async () => {
        const res = await http('GET', '/v1/sessions', { token });
        assert(res.status === 200 && Array.isArray(res.json?.sessions), `expected 200 with a sessions array, got ${describe(res)}`);
    });

    // Persistence across restarts: same key -> same account row, and a token
    // minted before the restart still verifies (tokens are derived from
    // HANDY_MASTER_SECRET, so a regenerated secret would log every device out).
    if (prior) {
        await check('account id matches the one saved in the state file', async () => {
            assert(accountId === prior.accountId, `expected account ${prior.accountId}, got ${accountId} — the database did not survive, or a new account was created`);
        });
        await check('token saved in the state file is still accepted', async () => {
            const res = await http('GET', '/v1/account/profile', { token: prior.token });
            assert(res.status === 200 && res.json?.id === prior.accountId, `expected 200 for account ${prior.accountId}, got ${describe(res)}`);
        });
    }
    saveState(keypair, accountId, token);

    // 5. Realtime over Socket.IO.
    await check(`Socket.IO over polling at ${SOCKET_PATH} rejects a bogus token with CONNECT_ERROR`, async () => {
        const { sid, reply } = await pollingConnect('not-a-real-token');
        await pollingClose(sid);
        assert(reply.startsWith('44'), `expected CONNECT_ERROR (44...), got ${reply}`);
    });

    await check(`Socket.IO over polling at ${SOCKET_PATH} connects and acks a ping`, async () => {
        const { sid, reply } = await pollingConnect(token);
        try {
            assert(reply.startsWith('40'), `expected CONNECT ack (40...), got ${reply}`);
            assert(typeof JSON.parse(reply.slice(2)).sid === 'string', `CONNECT ack has no sid: ${reply}`);
            const post = await http('POST', `${SOCKET_PATH}?EIO=4&transport=polling&sid=${sid}`, { body: '420["ping"]' });
            assert(post.status === 200, `POST of ping event: ${describe(post)}`);
            await pollFor(sid, (p) => p.startsWith('430'), 'ack of ping event');
        } finally {
            await pollingClose(sid);
        }
    });

    if (typeof globalThis.WebSocket === 'function') {
        await check(`Socket.IO over WebSocket at ${SOCKET_PATH} connects and acks a ping`, () => websocketPing(token));
    } else {
        skip(`Socket.IO over WebSocket at ${SOCKET_PATH}`, `no global WebSocket in Node ${process.version} (Node 22+ has it; Node 20 needs --experimental-websocket)`);
    }

    console.log(`# all ${checkCount} checks passed (account ${accountId})`);
}

main().catch((e) => {
    console.log(`not ok - smoke test crashed: ${e?.stack || e}`);
    process.exit(1);
});
