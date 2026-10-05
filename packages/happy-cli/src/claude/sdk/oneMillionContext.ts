/**
 * Adds Claude Code's `[1m]` model suffix — the one that selects the 1M-token
 * context window — to models that support it.
 *
 * Why this exists
 * ---------------
 * `[1m]` is not an API model id. The Claude CLI strips it out of the request
 * body and turns it into an `anthropic-beta: context-1m-2025-08-07` header,
 * and uses its presence to size the local context budget. So `sonnet` and
 * `sonnet[1m]` reach the same model, but the first is capped at 200K and the
 * second at 1M — with no error, no warning and nothing in the logs to tell
 * them apart. Measured against a first-party endpoint, reading
 * `modelUsage.*.contextWindow` out of `--output-format json`:
 *
 *   opus                 -> claude-opus-5     200000
 *   opus[1m]             -> claude-opus-5    1000000
 *   sonnet               -> claude-sonnet-5   200000
 *   sonnet[1m]           -> claude-sonnet-5  1000000
 *
 * The Happy app ships a hardcoded Claude model list — `default`, `opus`,
 * `sonnet`, `fable`, `haiku`, `claude-opus-5` — with no `[1m]` entries, and it
 * ships through the app stores, so anyone on a released build has no way to
 * ask for the wide window. Every layer a picked model crosses on its way to
 * the SDK types it as a free-form string, so we widen it here at the boundary
 * instead of shipping an app release.
 *
 * The SDK's `betas: ['context-1m-2025-08-07']` option is not an alternative:
 * the CLI drops it for OAuth/subscription auth ("Custom betas are only
 * available for API key users. Ignoring provided betas."). The suffix is the
 * only lever that works for both auth modes.
 *
 * Scope
 * -----
 * Only opus/sonnet/fable take the suffix. The CLI's own alias allowlist is
 * ["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]",
 * "fable[1m]", "opusplan"] — note there is no `haiku[1m]`, no `best[1m]` and
 * no `opusplan[1m]`.
 *
 * An absent model stays absent on purpose: that is how the app's "default
 * model" pick reaches the CLI, and the CLI then resolves the user's own
 * `/model` choice, ANTHROPIC_MODEL, or `~/.claude/settings.json`.
 *
 * Set HAPPY_DISABLE_1M_CONTEXT=1 to opt out — the window above 200K is priced
 * differently, and some plans require usage credits and will otherwise 429 and
 * clamp back to 200K.
 */

const ONE_MILLION_SUFFIX = '[1m]'

/** Aliases the CLI accepts with the suffix attached. */
const SUFFIXABLE_ALIASES = new Set(['opus', 'sonnet', 'fable'])

/** Full model ids whose families support the suffix, e.g. claude-sonnet-4-6. */
const SUFFIXABLE_MODEL_ID = /^claude-(opus|sonnet|fable)-/

const ALREADY_SUFFIXED = /\[1m\]/i

export function supportsOneMillionContext(model: string): boolean {
    const normalized = model.toLowerCase()
    return SUFFIXABLE_ALIASES.has(normalized) || SUFFIXABLE_MODEL_ID.test(normalized)
}

export function applyOneMillionContext(model: string | undefined, disabled: boolean): string | undefined {
    if (!model || disabled) {
        return model
    }
    if (ALREADY_SUFFIXED.test(model) || !supportsOneMillionContext(model)) {
        return model
    }
    return `${model}${ONE_MILLION_SUFFIX}`
}

/**
 * Drop the suffix, so an id can be compared against one that may not carry it.
 *
 * The CLI is asymmetric about where the suffix survives: a result message keys
 * `modelUsage` by the suffixed id (`claude-opus-5[1m]`), while the assistant
 * messages of that same turn report the bare id (`claude-opus-5`). Anything
 * correlating the two has to normalize both sides first — see
 * `SDKToLogConverter`, where matching them raw silently drops the window.
 */
export function stripOneMillionContext(model: string): string {
    return model.replace(ALREADY_SUFFIXED, '')
}
