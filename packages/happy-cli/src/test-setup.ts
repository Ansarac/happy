/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * We only build the CLI here. Integration suites now provision their own
 * isolated environments so each suite can get a fresh lab-rat project copy.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import psList from 'ps-list'

const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

/**
 * PIDs executing out of our `dist/`, or null if they could not be enumerated.
 *
 * `pnpm build` opens with `shx rm -rf dist`, and on a developer box the daemon
 * and every session it spawned are running from that directory. The bundle is
 * code split, so a process that has not yet reached one of its lazy imports
 * loses the chunk out from under it and dies mid-turn: running the unit suite
 * would take live agent sessions with it.
 */
async function findDistReaders(): Promise<number[] | null> {
    try {
        const processes = await psList()
        return processes
            .filter((proc) => proc.pid !== process.pid && (proc.cmd ?? '').includes(DIST_DIR))
            .map((proc) => proc.pid)
    } catch {
        // Best effort, and the two failure modes are not symmetric: a stale
        // chunk left behind is harmless, a deleted one kills sessions.
        return null
    }
}

function runBuildStep(args: string[]): void {
    const result = spawnSync('pnpm', args, { stdio: 'pipe' })
    const stderr = result.stderr?.toString() ?? ''
    if (stderr.length > 0) {
        console.error(`Build stderr (could be debugger output): ${stderr}`)
        console.log(`Build stdout: ${result.stdout?.toString() ?? ''}`)
    }
    // `pnpm build` chains its steps with `&&`, so a type error reaches a caller
    // only as a non-zero exit — tsc reports on stdout, not stderr. The in-place
    // path runs those steps as separate commands and needs the same gate.
    if (result.status !== 0) {
        throw new Error(
            `\`pnpm ${args.join(' ')}\` failed with exit code ${result.status}: ` +
            (stderr || result.stdout?.toString() || '(no output)')
        )
    }
}

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'

    const readers = await findDistReaders()
    if (readers?.length === 0) {
        // Nothing is reading dist, so take the clean build — it is the only one
        // that drops chunks orphaned by earlier builds.
        runBuildStep(['build'])
        return
    }

    // pkgroll overwrites in place and never deletes, so skipping the clean step
    // closes the window: an old chunk stays readable until a build writes the
    // same name over it.
    const reason = readers === null
        ? 'could not enumerate processes'
        : `pids ${readers.join(', ')} are running from it`
    console.log(`[test-setup] Building in place without cleaning ${DIST_DIR} — ${reason}.`)
    runBuildStep(['exec', 'tsc', '--noEmit'])
    runBuildStep(['exec', 'pkgroll'])
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
}
