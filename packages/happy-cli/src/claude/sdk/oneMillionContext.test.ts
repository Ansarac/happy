import { describe, expect, it } from 'vitest'

import { applyOneMillionContext, stripOneMillionContext, supportsOneMillionContext } from './oneMillionContext'

describe('supportsOneMillionContext', () => {
    it('accepts the aliases the CLI allowlists with a [1m] form', () => {
        expect(supportsOneMillionContext('opus')).toBe(true)
        expect(supportsOneMillionContext('sonnet')).toBe(true)
        expect(supportsOneMillionContext('fable')).toBe(true)
    })

    it('accepts full model ids from the same families', () => {
        expect(supportsOneMillionContext('claude-opus-5')).toBe(true)
        expect(supportsOneMillionContext('claude-sonnet-4-6')).toBe(true)
        expect(supportsOneMillionContext('claude-fable-5')).toBe(true)
    })

    it('rejects models the CLI has no [1m] alias for', () => {
        // The CLI allowlist is ["sonnet", "opus", "haiku", "fable", "best",
        // "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan"] — `haiku[1m]`,
        // `best[1m]` and `opusplan[1m]` do not exist.
        expect(supportsOneMillionContext('haiku')).toBe(false)
        expect(supportsOneMillionContext('claude-haiku-4-5-20251001')).toBe(false)
        expect(supportsOneMillionContext('best')).toBe(false)
        expect(supportsOneMillionContext('opusplan')).toBe(false)
    })

    it('rejects ids that merely start with a supported family name', () => {
        expect(supportsOneMillionContext('opusplan')).toBe(false)
        expect(supportsOneMillionContext('sonnetish')).toBe(false)
    })
})

describe('applyOneMillionContext', () => {
    it('widens a supported model', () => {
        expect(applyOneMillionContext('sonnet', false)).toBe('sonnet[1m]')
        expect(applyOneMillionContext('opus', false)).toBe('opus[1m]')
        expect(applyOneMillionContext('claude-opus-5', false)).toBe('claude-opus-5[1m]')
    })

    it('leaves an absent model absent so the CLI resolves its own default', () => {
        // This is the app's "default model" pick: daemon/run.ts sends no
        // --model, and the CLI then honours /model, ANTHROPIC_MODEL or
        // ~/.claude/settings.json. Substituting anything here would override it.
        expect(applyOneMillionContext(undefined, false)).toBeUndefined()
        expect(applyOneMillionContext('', false)).toBe('')
    })

    it('does not double-suffix', () => {
        expect(applyOneMillionContext('sonnet[1m]', false)).toBe('sonnet[1m]')
        expect(applyOneMillionContext('claude-opus-5[1M]', false)).toBe('claude-opus-5[1M]')
    })

    it('leaves unsupported models alone', () => {
        expect(applyOneMillionContext('haiku', false)).toBe('haiku')
        expect(applyOneMillionContext('opusplan', false)).toBe('opusplan')
    })

    it('is a no-op when disabled', () => {
        expect(applyOneMillionContext('sonnet', true)).toBe('sonnet')
        expect(applyOneMillionContext('claude-opus-5', true)).toBe('claude-opus-5')
    })
})

describe('stripOneMillionContext', () => {
    it('removes the suffix', () => {
        expect(stripOneMillionContext('claude-opus-5[1m]')).toBe('claude-opus-5')
        expect(stripOneMillionContext('sonnet[1m]')).toBe('sonnet')
    })

    it('matches the case-insensitivity of the apply side', () => {
        expect(stripOneMillionContext('claude-opus-5[1M]')).toBe('claude-opus-5')
    })

    it('leaves an unsuffixed model untouched', () => {
        expect(stripOneMillionContext('claude-opus-5')).toBe('claude-opus-5')
        expect(stripOneMillionContext('haiku')).toBe('haiku')
        expect(stripOneMillionContext('')).toBe('')
    })

    it('round-trips whatever apply produced', () => {
        for (const model of ['opus', 'sonnet', 'fable', 'claude-opus-5', 'haiku', 'opusplan']) {
            expect(stripOneMillionContext(applyOneMillionContext(model, false)!)).toBe(model)
        }
    })
})
