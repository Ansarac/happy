/**
 * Upgrades the app's pinned `claude-opus-5` to `claude-opus-5-5`.
 *
 * Why this exists
 * ---------------
 * Opus 5.5 shipped in Claude Code 2.1.281, and the CLI's baked catalog makes it
 * the head of the opus family:
 *
 *   aliases.opus.default  = "claude-opus-5-5"
 *   latest_per_family.opus = "claude-opus-5-5"
 *
 * so a bare `--model opus` already resolves to it with no help from us. The
 * Happy app does not send the alias. Its picker deliberately ships full model
 * ids — see the comment above `getClaudeModelModes()`, which explains that the
 * aliases "do not all mean what the row says" — so the `Opus 5` row sends the
 * literal string `claude-opus-5`. That id is still valid and still resolves;
 * it just pins the previous release. The catalog keeps it listed with the
 * description "Opus 5 - previous Opus version".
 *
 * The picker ships through the app stores, so a new row cannot reach a build
 * that is already installed. Same situation, and same fix, as the `[1m]`
 * suffix: rewrite at the SDK boundary instead of shipping an app release.
 *
 * What changes
 * ------------
 * Read out of the 2.1.281 catalog:
 *
 *                      claude-opus-5          claude-opus-5-5
 *   display_name       Opus 5                 Opus 5.5
 *   knowledge_cutoff   May 2026               June 2026
 *   pricing            tier_5_25              tier_4_20_cache_read_0_20
 *   max_output default 64000                  128000
 *   context            1e6, native_1m         1e6, native_1m
 *   supports_1m_suffix true                   true
 *
 * So this is not a more expensive model: 5.5 is the cheaper tier of the two.
 * Both are natively 1M and both take the `[1m]` suffix, which is why this
 * composes with applyOneMillionContext rather than conflicting with it.
 *
 * 5.5 adds `rejects_disabled_thinking` to its capability list. Happy never
 * sends `thinking: {type: "disabled"}` — it passes `effort` through and leaves
 * thinking to the CLI's default — so nothing here has to change for it.
 *
 * Scope
 * -----
 * Only the exact id `claude-opus-5` is rewritten, with or without a `[1m]`
 * suffix. Everything else is left alone:
 *
 *   - `opus` and the other aliases already resolve to the family head.
 *   - `claude-opus-4-8` and friends are deliberate pins to an older release.
 *   - `claude-opus-5-5` is already current, and matters more than it looks:
 *     `claude-opus-5` is a *prefix* of `claude-opus-5-5`, so a substring
 *     rewrite would turn an already-upgraded id into `claude-opus-5-5-5`.
 *     The comparison below is on the whole base id for that reason.
 *
 * Gated on the binary that actually runs
 * --------------------------------------
 * The rewritten id is only valid if the `claude` binary that spawns the
 * session knows it, and that is the one the Agent SDK bundles — **not** the
 * native install `happy --version` reports. Conflating the two shipped
 * `claude-opus-5-5` to a bundled 2.1.260 binary and failed every turn with:
 *
 *   Claude Code 2.1.260 does not support this model; version 2.1.280 or newer
 *   is required.  (error_code: claude_code_version_too_old)
 *
 * So support is now a probe of the real binary (see agentSdkBinaryVersion)
 * rather than a comment asking a future reader to re-check. An unknown version
 * counts as unsupported.
 *
 * Set HAPPY_DISABLE_OPUS_5_5=1 to keep the app's pick verbatim.
 */

import { compareVersions } from './agentSdkBinaryVersion'

const OPUS_5 = 'claude-opus-5'
const OPUS_5_5 = 'claude-opus-5-5'

/**
 * First Claude Code release that accepts `claude-opus-5-5`.
 *
 * Taken verbatim from the API's own rejection — "version 2.1.280 or newer is
 * required" — rather than from the version this was developed against
 * (2.1.281), so the gate is exactly as permissive as the server is.
 */
export const MIN_OPUS_5_5_CLAUDE_VERSION = '2.1.280'

/** Split `claude-opus-5[1m]` into its base id and the suffix, if any. */
const SUFFIX = /(\[1m\])$/i

/**
 * `null` means the version could not be established, and is deliberately
 * treated as unsupported: leaving the app's own `claude-opus-5` in place works
 * on every release, while guessing wrong the other way breaks every turn.
 */
export function supportsOpus55(claudeVersion: string | null): boolean {
    if (!claudeVersion) {
        return false
    }
    return compareVersions(claudeVersion, MIN_OPUS_5_5_CLAUDE_VERSION) >= 0
}

export function applyLatestOpus(
    model: string | undefined,
    disabled: boolean,
    claudeVersion: string | null,
): string | undefined {
    if (!model || disabled || !supportsOpus55(claudeVersion)) {
        return model
    }
    const suffix = SUFFIX.exec(model)?.[1] ?? ''
    const base = suffix ? model.slice(0, -suffix.length) : model
    if (base.toLowerCase() !== OPUS_5) {
        return model
    }
    return `${OPUS_5_5}${suffix}`
}
