import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import {
    agentSdkBinaryCandidates,
    verifyAgentSdkBinary,
    SKIP_SDK_BINARY_CHECK_ENV,
} from './verifyAgentSdkBinary';

const SDK = '@anthropic-ai/claude-agent-sdk';

describe('agentSdkBinaryCandidates', () => {
    it('accepts either libc variant on linux, glibc first like the SDK', () => {
        expect(agentSdkBinaryCandidates(SDK, 'linux', 'x64')).toEqual([
            { packageName: `${SDK}-linux-x64`, specifier: `${SDK}-linux-x64/claude` },
            { packageName: `${SDK}-linux-x64-musl`, specifier: `${SDK}-linux-x64-musl/claude` },
        ]);
    });

    it('carries the arch through rather than assuming x64', () => {
        expect(agentSdkBinaryCandidates(SDK, 'linux', 'arm64').map((c) => c.packageName)).toEqual([
            `${SDK}-linux-arm64`,
            `${SDK}-linux-arm64-musl`,
        ]);
    });

    it('has a single candidate on darwin', () => {
        expect(agentSdkBinaryCandidates(SDK, 'darwin', 'arm64')).toEqual([
            { packageName: `${SDK}-darwin-arm64`, specifier: `${SDK}-darwin-arm64/claude` },
        ]);
    });

    it('looks for claude.exe on win32', () => {
        expect(agentSdkBinaryCandidates(SDK, 'win32', 'x64')).toEqual([
            { packageName: `${SDK}-win32-x64`, specifier: `${SDK}-win32-x64/claude.exe` },
        ]);
    });

    // Termux reports platform 'android'. The SDK resolver has a branch for it
    // even though no android package appears in its optionalDependencies, so
    // deriving candidates from that field instead would miss this case.
    it('maps android onto the linux-<arch>-android package', () => {
        expect(agentSdkBinaryCandidates(SDK, 'android', 'arm64')).toEqual([
            { packageName: `${SDK}-linux-arm64-android`, specifier: `${SDK}-linux-arm64-android/claude` },
        ]);
    });

    it('follows the SDK package name so a rename does not need a code change', () => {
        expect(agentSdkBinaryCandidates('@scope/renamed', 'darwin', 'x64')[0].packageName)
            .toBe('@scope/renamed-darwin-x64');
    });
});

describe('verifyAgentSdkBinary', () => {
    afterEach(() => {
        delete process.env[SKIP_SDK_BINARY_CHECK_ENV];
    });

    // Runs against whatever is actually installed. Asserting ok === true would
    // fail on any --omit=optional CI runner, so assert that each branch is
    // internally consistent instead.
    it('reports a real, existing executable or an actionable failure', () => {
        const result = verifyAgentSdkBinary();
        if (result.ok) {
            expect(result.execPath).not.toBeNull();
            expect(existsSync(result.execPath!)).toBe(true);
            expect(result.execPath).toContain('claude');
        } else {
            expect(result.expected.length).toBeGreaterThan(0);
            expect(result.message).toContain(`${process.platform}-${process.arch}`);
            expect(result.message).toContain(SKIP_SDK_BINARY_CHECK_ENV);
        }
    });

    it('passes without touching the filesystem when the bypass is set', () => {
        process.env[SKIP_SDK_BINARY_CHECK_ENV] = '1';
        const result = verifyAgentSdkBinary();
        expect(result.ok).toBe(true);
        expect(result.ok && result.execPath).toBeNull();
    });
});
