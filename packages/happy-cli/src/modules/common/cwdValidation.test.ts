import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateCwd } from './cwdValidation';

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'happy-cwd-validation-'));
    mkdirSync(join(root, 'capital-stack'));
    writeFileSync(join(root, 'notes.txt'), 'not a directory');
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('validateCwd', () => {
    it('accepts a directory that exists', () => {
        expect(validateCwd(join(root, 'capital-stack'))).toEqual({ valid: true });
    });

    // The original failure: the app's directory picker sent a prefix of a real
    // path, which reached exec() and came back as `spawn /bin/sh ENOENT`.
    it('rejects a half-typed path and names the directory, not the shell', () => {
        const halfTyped = join(root, 'capital-');
        const result = validateCwd(halfTyped);
        expect(result.valid).toBe(false);
        expect(result.error).toBe(`Working directory does not exist: ${halfTyped}`);
    });

    it('rejects a path that exists but is a file', () => {
        const file = join(root, 'notes.txt');
        expect(validateCwd(file)).toEqual({
            valid: false,
            error: `Working directory is not a directory: ${file}`,
        });
    });

    it('rejects a path whose parent is a file rather than calling it a directory', () => {
        const throughFile = join(root, 'notes.txt', 'child');
        const result = validateCwd(throughFile);
        expect(result.valid).toBe(false);
        expect(result.error).toBe(`Working directory does not exist: ${throughFile}`);
    });

    // Distinguishing EACCES from ENOENT is the whole point of not collapsing
    // every stat failure into "does not exist". root bypasses the mode bits,
    // so there is nothing to assert when the suite runs as root.
    it.skipIf(process.getuid?.() === 0)('reports an unreadable parent as inaccessible, not missing', () => {
        const locked = join(root, 'locked');
        mkdirSync(locked);
        mkdirSync(join(locked, 'inner'));
        chmodSync(locked, 0o000);
        try {
            const target = join(locked, 'inner');
            const result = validateCwd(target);
            expect(result.valid).toBe(false);
            expect(result.error).toBe(`Working directory is not accessible (EACCES): ${target}`);
        } finally {
            chmodSync(locked, 0o700);
        }
    });
});
