/**
 * The Claude model catalog happy-cli publishes into session metadata, so the
 * app's model picker shows what will actually run.
 *
 * Why this exists
 * ---------------
 * The app prefers `metadata.models` and `metadata.currentModelCode` over its
 * own hardcoded Claude list (getAvailableModels in the app's
 * modelModeOptions.ts), but happy-cli only ever published them for ACP agents.
 * So a Claude session drew the hardcoded list, while the SDK boundary rewrote
 * what was picked — `claude-opus-5` ran as `claude-opus-5-5[1m]` and the chip
 * still said "Opus 5". The installed app builds cannot be changed, and do not
 * need to be: they already render whatever the CLI publishes.
 *
 * Source of truth
 * ---------------
 * The rows come from `Query.supportedModels()` — the binary that runs the
 * session describing itself — and the current model from the `system/init`
 * message of the same query. Nothing here is a list maintained by hand, so a
 * model this binary does not know cannot be offered, which is the failure the
 * version gate in latestOpus exists to prevent on the other path.
 *
 * Invariant
 * ---------
 * Every published code is exactly what query.ts would send for it: each row
 * is passed through the same effectiveClaudeModel() transform before it
 * becomes a code. So picking a row runs that row, and two rows that would run
 * the same model are one row — under default 1M widening `opus` and `opus[1m]`
 * collapse, and a previous-release `claude-opus-5` row collapses into Opus 5.5
 * when the rewrite applies.
 *
 * Codes are full model ids rather than the CLI's aliases, matching the app's
 * own keys and the reason it gives for them: an alias does not say which
 * release it means.
 *
 * The `default` row is left out. The app's list deliberately has none, and
 * `default` is not a model value the CLI accepts from the app today.
 */

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

import { configuration } from '@/configuration'

import { agentSdkBinaryVersion } from './agentSdkBinaryVersion'
import { applyLatestOpus } from './latestOpus'
import { applyOneMillionContext, stripOneMillionContext } from './oneMillionContext'

export type CatalogRow = Pick<ModelInfo, 'value' | 'displayName' | 'description' | 'resolvedModel'>

/** One entry of `metadata.models`: `code` is sent back as the model, `value` is the label. */
export type PublishedModel = { code: string; value: string; description?: string | null }

export type ClaudeModelCatalog = { models: PublishedModel[]; currentModelCode?: string }

const DEFAULT_ROW = 'default'
const SUFFIX = /\[1m\]$/i

/**
 * The model query.ts sends for a picked model: Opus 5 upgraded where the
 * running binary supports it, then widened to 1M where the family takes it.
 * Shared with query.ts so the catalog and the request cannot drift apart.
 */
export function effectiveClaudeModel(model: string | undefined): string | undefined {
    return applyOneMillionContext(
        applyLatestOpus(model, configuration.disableOpus55, agentSdkBinaryVersion()),
        configuration.disable1mContext,
    )
}

/** The full id a row stands for, keeping a `[1m]` the row's own value asked for. */
function canonicalId(row: CatalogRow): string {
    const base = row.resolvedModel || row.value
    return SUFFIX.test(row.value) && !SUFFIX.test(base) ? `${base}[1m]` : base
}

/**
 * The label the app shows, which is the whole point of publishing: it must
 * name the release that runs. `displayName` alone does not — measured on
 * 2.1.289 it is just "Opus" or "Sonnet" — while the description opens with the
 * versioned name ("Opus 5.5 · Best for everyday, complex tasks · …"). So that
 * first segment becomes the label when it extends the display name, and the
 * rest stays the description.
 *
 * A `[1m]` code gets " [1M]", the app's own spelling for its 1M rows
 * ("Opus 5 [1M]"), because widening means the window is part of what runs.
 *
 * `rank` orders candidates when rows collapse onto one code: 0 when the
 * transform swapped the model (a previous-release row rewritten to the current
 * one — its label names the wrong release, so the code stands in for it), 1
 * for the same model without a versioned name, 2 with one. The window is not
 * ranked: the suffix above restores it from the code either way.
 */
function rowLabel(row: CatalogRow, canonical: string, code: string): { model: PublishedModel; rank: number } {
    if (stripOneMillionContext(canonical) !== stripOneMillionContext(code)) {
        return { model: { code, value: code, description: null }, rank: 0 }
    }
    const [head = '', ...rest] = row.description.split(' · ')
    const versioned = head.startsWith(row.displayName) && head !== row.displayName
    const name = versioned ? head : row.displayName
    const description = (versioned ? rest.join(' · ') : row.description) || null
    return {
        model: { code, value: SUFFIX.test(code) ? `${name} [1M]` : name, description },
        rank: versioned ? 2 : 1,
    }
}

export function buildClaudeModelCatalog(
    rows: readonly CatalogRow[],
    toEffective: (model: string) => string,
): PublishedModel[] {
    const byCode = new Map<string, { model: PublishedModel; rank: number }>()
    for (const row of rows) {
        if (row.value.toLowerCase() === DEFAULT_ROW) {
            continue
        }
        const canonical = canonicalId(row)
        const candidate = rowLabel(row, canonical, toEffective(canonical))
        const existing = byCode.get(candidate.model.code)
        if (existing && existing.rank >= candidate.rank) {
            continue
        }
        // Map.set on an existing key keeps its original position, so the
        // published order stays the binary's order.
        byCode.set(candidate.model.code, candidate)
    }
    return [...byCode.values()].map(({ model }) => model)
}

/**
 * Attach the running model. The init message reports it with any `[1m]`
 * suffix, so an exact match is expected; a suffix-insensitive match covers a
 * binary that reports the bare id. A model that matches no row is appended as
 * its own row, so the chip always has something true to select.
 */
export function withCurrentModel(models: PublishedModel[], initModel: string | undefined): ClaudeModelCatalog {
    if (!initModel) {
        return { models }
    }
    const exact = models.find((model) => model.code === initModel)
    if (exact) {
        return { models, currentModelCode: exact.code }
    }
    const bare = stripOneMillionContext(initModel)
    const loose = models.filter((model) => stripOneMillionContext(model.code) === bare)
    if (loose.length === 1) {
        return { models, currentModelCode: loose[0].code }
    }
    return { models: [...models, { code: initModel, value: initModel, description: null }], currentModelCode: initModel }
}

/** What claudeRemote publishes after a query's init: the catalog plus the running model. */
export function publishedClaudeCatalog(rows: readonly CatalogRow[], initModel: string | undefined): ClaudeModelCatalog {
    const toEffective = (model: string) => effectiveClaudeModel(model) ?? model
    return withCurrentModel(buildClaudeModelCatalog(rows, toEffective), initModel)
}
