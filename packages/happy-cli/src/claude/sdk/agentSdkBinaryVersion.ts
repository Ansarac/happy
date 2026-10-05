/**
 * Version of the `claude` binary the Agent SDK will actually spawn.
 *
 * Why this exists
 * ---------------
 * There are two Claude Code installations on a typical developer box and they
 * are not the same version:
 *
 *   - the one the SDK ships, at
 *     node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
 *   - a native install the user manages themselves, e.g. under
 *     ~/.local/share/claude/versions/
 *
 * `happy --version` prints the *native* one ("Using Claude Code vX from native
 * installer"), but a session is spawned from the *bundled* one. Reading the
 * first and concluding something about the second is how
 * `claude-opus-5-5` reached a binary that had never heard of it, failing every
 * turn with:
 *
 *   Claude Code 2.1.260 does not support this model; version 2.1.280 or newer
 *   is required.  (error_code: claude_code_version_too_old)
 *
 * So this asks the binary that will run, rather than any other source. In
 * particular it does **not** infer the version from the platform package's
 * own version. Those happen to track today — package 0.3.260 ships binary
 * 2.1.260 — but that is an undocumented coincidence of release numbering, and
 * substituting it for the real thing is the same class of assumption that
 * caused the outage.
 *
 * Cost
 * ----
 * `claude --version` measured at 17ms on linux-x64, and the result is cached
 * for the lifetime of the process, so the probe is paid at most once. That is
 * cheap enough to do synchronously on the query path, which matters because
 * Options are assembled synchronously in query.ts.
 */

import { spawnSync } from 'node:child_process'

import { verifyAgentSdkBinary } from '@/claude/utils/verifyAgentSdkBinary'

/** Parsed from e.g. `2.1.289 (Claude Code)`. */
const VERSION_LINE = /\b(\d+)\.(\d+)\.(\d+)\b/

let cached: { value: string | null } | undefined

/**
 * `null` whenever the version cannot be established — the binary could not be
 * resolved, the spawn failed, or the output did not parse. Callers must treat
 * null as "assume unsupported": an unknown binary is far more likely to be an
 * old one than a new one, and the cost of guessing wrong is every turn failing.
 */
export function agentSdkBinaryVersion(): string | null {
    if (cached) {
        return cached.value
    }
    cached = { value: probe() }
    return cached.value
}

function probe(): string | null {
    const check = verifyAgentSdkBinary()
    // execPath is null when the pre-flight was explicitly skipped; there is no
    // path to ask in that case.
    if (!check.ok || !check.execPath) {
        return null
    }
    const result = spawnSync(check.execPath, ['--version'], { encoding: 'utf-8', timeout: 30_000 })
    if (result.error || result.status !== 0) {
        return null
    }
    const matched = VERSION_LINE.exec(`${result.stdout ?? ''}`)
    return matched ? `${matched[1]}.${matched[2]}.${matched[3]}` : null
}

/** Reset the memo. Tests only — a process never changes its binary mid-run. */
export function resetAgentSdkBinaryVersionCache(): void {
    cached = undefined
}

/**
 * Compare dotted numeric versions. Returns <0, 0, >0 like a sort comparator.
 *
 * Hand-rolled rather than pulling in semver: happy-cli does not depend on it,
 * and the only inputs are Claude Code's own `major.minor.patch`, which carries
 * no pre-release or build metadata for this comparison to get wrong.
 */
export function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i] ?? 0
        const r = right[i] ?? 0
        if (l !== r) {
            return l < r ? -1 : 1
        }
    }
    return 0
}
