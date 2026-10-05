import { describe, expect, it } from 'vitest'

import { applyLatestOpus } from './latestOpus'
import { buildClaudeModelCatalog, withCurrentModel, type CatalogRow } from './modelCatalog'
import { applyOneMillionContext } from './oneMillionContext'

/** A binary new enough for Opus 5.5, and the one that rejected it. */
const NEW = '2.1.289'
const OLD = '2.1.260'

/** The transform query.ts applies, with each input pinned instead of read from the environment. */
function transform(opts: { version?: string | null; disableOpus55?: boolean; disable1m?: boolean } = {}) {
    const { version = NEW, disableOpus55 = false, disable1m = false } = opts
    return (model: string) =>
        applyOneMillionContext(applyLatestOpus(model, disableOpus55, version), disable1m) ?? model
}

/**
 * Verbatim (minus effort fields) from `supportedModels()` on Claude Code
 * 2.1.289, API-token auth behind an LLM gateway, 2026-10-05. Note what an
 * API user's catalog lacks next to a subscription's: no `opus[1m]` or
 * `sonnet[1m]` rows, and Fable listed under its full suffixed id.
 */
const API_ROWS: CatalogRow[] = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok' },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
]

/** Subscription-shaped rows, from the /model options in the 2.1.281 binary: 1M twins and a previous release. */
const SUBSCRIPTION_ROWS: CatalogRow[] = [
    { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'Previous Opus version' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5', displayName: 'Opus (1M context)', description: 'Opus 5.5 for long sessions' },
]

const codes = (models: { code: string }[]) => models.map((model) => model.code)

describe('buildClaudeModelCatalog — the catalog this box actually returns', () => {
    const models = buildClaudeModelCatalog(API_ROWS, transform())

    it('publishes full ids that are exactly what query.ts would send', () => {
        expect(codes(models)).toEqual([
            'claude-opus-5-5[1m]',
            'claude-fable-5-1[1m]',
            'claude-sonnet-5-5[1m]',
            'claude-haiku-4-5-20251001',
        ])
    })

    it('names the release that runs, which displayName alone does not', () => {
        expect(models.map((model) => model.value)).toEqual([
            'Opus 5.5 [1M]',
            'Fable 5.1 [1M]',
            'Sonnet 5.5 [1M]',
            'Haiku 4.5',
        ])
        expect(models[0].description).toBe('Best for everyday, complex tasks · $4/$20 per Mtok')
    })

    it('leaves out the default row', () => {
        expect(models.some((model) => model.value.startsWith('Default'))).toBe(false)
    })

    it('does not widen when widening is opted out', () => {
        expect(codes(buildClaudeModelCatalog(API_ROWS, transform({ disable1m: true })))).toEqual([
            'claude-opus-5-5',
            'claude-fable-5-1[1m]',
            'claude-sonnet-5-5',
            'claude-haiku-4-5-20251001',
        ])
    })
})

describe('buildClaudeModelCatalog — collapsing rows that run the same model', () => {
    it('collapses 1M twins and a previous release into one versioned row', () => {
        // The previous-release row is first on purpose: first-seen must not
        // win, and neither may the twin whose name carries no version.
        const models = buildClaudeModelCatalog(SUBSCRIPTION_ROWS, transform())
        expect(models).toEqual([
            { code: 'claude-opus-5-5[1m]', value: 'Opus 5.5 [1M]', description: 'Best for everyday, complex tasks' },
        ])
    })

    it('keeps both windows apart when widening is off', () => {
        const models = buildClaudeModelCatalog(SUBSCRIPTION_ROWS, transform({ disable1m: true }))
        expect(codes(models)).toEqual(['claude-opus-5-5', 'claude-opus-5-5[1m]'])
    })

    it('keeps the previous release on a binary too old for the rewrite', () => {
        const models = buildClaudeModelCatalog(SUBSCRIPTION_ROWS, transform({ version: OLD }))
        expect(models[0]).toEqual({ code: 'claude-opus-5[1m]', value: 'Opus 5 [1M]', description: 'Previous Opus version' })
    })

    it('keeps the previous release when the rewrite is opted out', () => {
        expect(codes(buildClaudeModelCatalog(SUBSCRIPTION_ROWS, transform({ disableOpus55: true })))).toContain('claude-opus-5[1m]')
    })

    it('falls back to the code when the only row for a model names another release', () => {
        const models = buildClaudeModelCatalog([SUBSCRIPTION_ROWS[0]], transform())
        expect(models).toEqual([{ code: 'claude-opus-5-5[1m]', value: 'claude-opus-5-5[1m]', description: null }])
    })
})

describe('buildClaudeModelCatalog — older or sparser binaries', () => {
    it('falls back to the row value when the binary predates resolvedModel', () => {
        const rows: CatalogRow[] = [
            { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: '' },
            { value: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M)', description: '' },
        ]
        const models = buildClaudeModelCatalog(rows, transform())
        expect(codes(models)).toEqual(['claude-sonnet-5[1m]', 'claude-opus-5-5[1m]'])
        // An empty description is published as null rather than an empty line.
        expect(models[0].description).toBeNull()
    })

    it('publishes nothing for an empty or default-only catalog', () => {
        expect(buildClaudeModelCatalog([], transform())).toEqual([])
        expect(buildClaudeModelCatalog([API_ROWS[0]], transform())).toEqual([])
    })
})

describe('withCurrentModel', () => {
    const models = buildClaudeModelCatalog(API_ROWS, transform())

    it('selects the row the init message names', () => {
        expect(withCurrentModel(models, 'claude-opus-5-5[1m]').currentModelCode).toBe('claude-opus-5-5[1m]')
    })

    it('matches a bare id against its widened row', () => {
        const catalog = withCurrentModel(models, 'claude-sonnet-5-5')
        expect(catalog.currentModelCode).toBe('claude-sonnet-5-5[1m]')
        expect(catalog.models).toBe(models)
    })

    it('appends a model the catalog does not list, so the chip is never blank', () => {
        const catalog = withCurrentModel(models, 'claude-sonnet-5[1m]')
        expect(catalog.currentModelCode).toBe('claude-sonnet-5[1m]')
        expect(catalog.models.at(-1)).toEqual({ code: 'claude-sonnet-5[1m]', value: 'claude-sonnet-5[1m]', description: null })
    })

    it('does not guess between two windows of the same model', () => {
        // With widening off both windows are rows. An id that matches neither
        // exactly but both loosely (a differently cased suffix) is appended
        // rather than mapped onto one of them.
        const both = buildClaudeModelCatalog(SUBSCRIPTION_ROWS, transform({ disable1m: true }))
        const catalog = withCurrentModel(both, 'claude-opus-5-5[1M]')
        expect(catalog.currentModelCode).toBe('claude-opus-5-5[1M]')
        expect(catalog.models).toHaveLength(both.length + 1)
    })

    it('reports no current model when init named none', () => {
        expect(withCurrentModel(models, undefined)).toEqual({ models })
    })
})
