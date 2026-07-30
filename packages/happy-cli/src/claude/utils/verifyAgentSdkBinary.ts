/**
 * Startup pre-flight for the Claude Agent SDK's native `claude` binary.
 *
 * The SDK ships its executable in per-platform optional packages and only
 * resolves one at the moment a query() is issued. A truncated install —
 * `--omit=optional`, or a session that started while `pnpm install` was still
 * copying files — therefore produces a session that looks healthy right up
 * until every single turn fails with:
 *
 *   Native CLI binary for linux-x64 not found.
 *
 * Checking once at startup turns an hour of identical per-turn failures into
 * one actionable error before the user types anything.
 *
 * The candidate list mirrors the SDK's own resolver (verified by reading
 * `sdk.mjs` at 0.3.220): same package-name shape, same `<pkg>/claude[.exe]`
 * subpath, and — critically — the same require anchored at the SDK's own
 * directory. Under pnpm the platform packages live next to the SDK, not next
 * to us, so anchoring here would report a missing binary that is actually
 * present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Bypass for a pre-flight that is wrong — never wedge a session that would run. */
export const SKIP_SDK_BINARY_CHECK_ENV = 'HAPPY_SKIP_SDK_BINARY_CHECK';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export type AgentSdkBinaryCheck =
    | { ok: true; execPath: string }
    | { ok: true; execPath: null; skippedBecause: string }
    | { ok: false; expected: string[]; message: string };

/**
 * Module specifiers the SDK will try, in its own order. Exported so the
 * derivation can be exercised for platforms this machine isn't.
 *
 * Linux gets both libc variants because the SDK picks between them at runtime
 * and either one satisfies the pre-flight. Android is a real branch in the SDK
 * resolver even though no android package appears in its optionalDependencies.
 */
export function agentSdkBinaryCandidates(
    sdkPackage: string,
    platform: string,
    arch: string,
): { packageName: string; specifier: string }[] {
    const executable = platform === 'win32' ? 'claude.exe' : 'claude';
    const packages = platform === 'android'
        ? [`${sdkPackage}-linux-${arch}-android`]
        : platform === 'linux'
            ? [`${sdkPackage}-linux-${arch}`, `${sdkPackage}-linux-${arch}-musl`]
            : [`${sdkPackage}-${platform}-${arch}`];
    return packages.map((packageName) => ({ packageName, specifier: `${packageName}/${executable}` }));
}

function readOptionalDependencyNames(sdkEntryPath: string): string[] {
    // The SDK's package.json is absent from its `exports` map, so
    // require.resolve('<pkg>/package.json') throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    // Walking up from the resolved entry point is the only way in.
    try {
        const raw = readFileSync(join(dirname(sdkEntryPath), 'package.json'), 'utf-8');
        const parsed = JSON.parse(raw) as { optionalDependencies?: Record<string, string> };
        return Object.keys(parsed.optionalDependencies ?? {});
    } catch {
        return [];
    }
}

export function verifyAgentSdkBinary(): AgentSdkBinaryCheck {
    if (process.env[SKIP_SDK_BINARY_CHECK_ENV]) {
        return { ok: true, execPath: null, skippedBecause: `${SKIP_SDK_BINARY_CHECK_ENV} is set` };
    }

    let sdkEntryPath: string;
    try {
        sdkEntryPath = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    } catch {
        return {
            ok: false,
            expected: [SDK_PACKAGE],
            message: `${SDK_PACKAGE} could not be resolved. Reinstall dependencies (pnpm install, or npm install -g happy) and retry. Set ${SKIP_SDK_BINARY_CHECK_ENV}=1 to bypass this check.`,
        };
    }

    const sdkRequire = createRequire(sdkEntryPath);
    const candidates = agentSdkBinaryCandidates(SDK_PACKAGE, process.platform, process.arch);
    for (const { specifier } of candidates) {
        try {
            const execPath = sdkRequire.resolve(specifier);
            if (existsSync(execPath)) {
                return { ok: true, execPath };
            }
        } catch {
            // Not installed. Try the next libc variant before giving up.
        }
    }

    // Distinguish "the install dropped these packages" from "the SDK publishes
    // nothing for this platform" — the two need completely different fixes.
    // An unreadable package.json yields an empty list; assume the common case.
    const published = readOptionalDependencyNames(sdkEntryPath);
    const platformIsPublished = published.length === 0
        || candidates.some(({ packageName }) => published.includes(packageName));

    const expected = candidates.map(({ specifier }) => specifier);
    const target = `${process.platform}-${process.arch}`;
    const message = platformIsPublished
        ? `Native CLI binary for ${target} not found. The Claude Agent SDK cannot start without it, and every turn would fail with this same error. Reinstall ${SDK_PACKAGE} without --omit=optional (pnpm install --force, or npm install -g happy) and retry. Set ${SKIP_SDK_BINARY_CHECK_ENV}=1 to bypass this check.`
        : `Native CLI binary for ${target} not found, and ${SDK_PACKAGE} publishes no binary for this platform. Point the SDK at a Claude Code executable you built or installed yourself, or run Happy on a supported platform. Set ${SKIP_SDK_BINARY_CHECK_ENV}=1 to bypass this check.`;

    return { ok: false, expected, message };
}
