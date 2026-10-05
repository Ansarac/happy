import { describe, expect, it } from 'vitest'

import { applyLatestOpus, supportsOpus55, MIN_OPUS_5_5_CLAUDE_VERSION } from './latestOpus'
import { compareVersions } from './agentSdkBinaryVersion'
import { applyOneMillionContext } from './oneMillionContext'

/** A binary new enough to accept the id. */
const NEW = '2.1.289'
/** The bundled binary that caused the outage. */
const OLD = '2.1.260'

describe('compareVersions', () => {
    it('orders by numeric component, not lexically', () => {
        // The bug this guards: '2.1.260' > '2.1.280' is true as strings.
        expect(compareVersions('2.1.260', '2.1.280')).toBeLessThan(0)
        expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0)
    })

    it('treats equal versions as equal and handles ragged lengths', () => {
        expect(compareVersions('2.1.280', '2.1.280')).toBe(0)
        expect(compareVersions('2.1', '2.1.0')).toBe(0)
        expect(compareVersions('2.2', '2.1.999')).toBeGreaterThan(0)
    })
})

describe('supportsOpus55', () => {
    it('accepts the documented minimum and anything newer', () => {
        expect(supportsOpus55(MIN_OPUS_5_5_CLAUDE_VERSION)).toBe(true)
        expect(supportsOpus55('2.1.281')).toBe(true)
        expect(supportsOpus55('2.2.0')).toBe(true)
        expect(supportsOpus55('3.0.0')).toBe(true)
    })

    it('rejects the version that actually failed in production', () => {
        expect(supportsOpus55(OLD)).toBe(false)
    })

    it('treats an unknown version as unsupported', () => {
        // Failing closed is the whole point: leaving claude-opus-5 alone works
        // on every release, guessing wrong breaks every turn.
        expect(supportsOpus55(null)).toBe(false)
        expect(supportsOpus55('')).toBe(false)
    })
})

describe('applyLatestOpus', () => {
    it('upgrades the id the app picker pins, on a supported binary', () => {
        expect(applyLatestOpus('claude-opus-5', false, NEW)).toBe('claude-opus-5-5')
    })

    it('does NOT upgrade on the binary that rejects the id', () => {
        // Regression: this exact combination produced
        // "Claude Code 2.1.260 does not support this model" on every turn.
        expect(applyLatestOpus('claude-opus-5', false, OLD)).toBe('claude-opus-5')
        expect(applyLatestOpus('claude-opus-5[1m]', false, OLD)).toBe('claude-opus-5[1m]')
    })

    it('does NOT upgrade when the binary version is unknown', () => {
        expect(applyLatestOpus('claude-opus-5', false, null)).toBe('claude-opus-5')
    })

    it('keeps the [1m] suffix on the upgraded id', () => {
        expect(applyLatestOpus('claude-opus-5[1m]', false, NEW)).toBe('claude-opus-5-5[1m]')
    })

    it('leaves an already-current id alone', () => {
        // claude-opus-5 is a prefix of claude-opus-5-5; a substring rewrite
        // would produce claude-opus-5-5-5 here.
        expect(applyLatestOpus('claude-opus-5-5', false, NEW)).toBe('claude-opus-5-5')
        expect(applyLatestOpus('claude-opus-5-5[1m]', false, NEW)).toBe('claude-opus-5-5[1m]')
    })

    it('leaves aliases alone — the CLI already resolves them to the family head', () => {
        expect(applyLatestOpus('opus', false, NEW)).toBe('opus')
        expect(applyLatestOpus('opus[1m]', false, NEW)).toBe('opus[1m]')
        expect(applyLatestOpus('opusplan', false, NEW)).toBe('opusplan')
        expect(applyLatestOpus('best', false, NEW)).toBe('best')
    })

    it('leaves deliberate pins to older releases alone', () => {
        expect(applyLatestOpus('claude-opus-4-8', false, NEW)).toBe('claude-opus-4-8')
        expect(applyLatestOpus('claude-opus-4-6', false, NEW)).toBe('claude-opus-4-6')
    })

    it('leaves other families alone', () => {
        expect(applyLatestOpus('claude-sonnet-5', false, NEW)).toBe('claude-sonnet-5')
        expect(applyLatestOpus('claude-fable-5-1', false, NEW)).toBe('claude-fable-5-1')
    })

    it('honours the opt-out even on a supported binary', () => {
        expect(applyLatestOpus('claude-opus-5', true, NEW)).toBe('claude-opus-5')
    })

    it('leaves an absent model absent', () => {
        // How the app's "default model" pick reaches the CLI, which then
        // resolves /model, ANTHROPIC_MODEL or ~/.claude/settings.json.
        expect(applyLatestOpus(undefined, false, NEW)).toBeUndefined()
    })
})

describe('applyLatestOpus composed with applyOneMillionContext', () => {
    // query.ts upgrades first, then widens. Pin the composition, since the
    // two rewrites both key off the same suffix.
    const both = (model: string | undefined, version: string | null = NEW) =>
        applyOneMillionContext(applyLatestOpus(model, false, version), false)

    it('upgrades and widens the plain Opus 5 row', () => {
        expect(both('claude-opus-5')).toBe('claude-opus-5-5[1m]')
    })

    it('does not double-suffix the Opus 5 [1M] row', () => {
        expect(both('claude-opus-5[1m]')).toBe('claude-opus-5-5[1m]')
    })

    it('still widens on an old binary, just without upgrading', () => {
        // The 1M suffix predates Opus 5.5 and is not version-gated, so an old
        // binary must keep the wide window it already had.
        expect(both('claude-opus-5', OLD)).toBe('claude-opus-5[1m]')
    })

    it('still widens families it does not upgrade', () => {
        expect(both('claude-sonnet-5')).toBe('claude-sonnet-5[1m]')
        expect(both('opus')).toBe('opus[1m]')
    })
})
