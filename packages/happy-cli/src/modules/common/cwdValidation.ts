/**
 * Existence check for a shell RPC's working directory.
 *
 * Kept separate from pathSecurity.ts on purpose. That module answers "is this
 * path allowed" — a security boundary. This one answers "is this path there",
 * which is a usability question, and conflating the two would invite treating
 * a missing directory as an attack or an unreadable one as a typo.
 *
 * Why it is needed at all: under the daemon the RPC surface is machine-scoped
 * (`workingDirectory === null`), so the security check degrades to a bare
 * resolve() that never touches the filesystem. A half-typed path from the
 * app's directory picker therefore passes validation untouched and only fails
 * inside exec(), where it surfaces as `spawn /bin/sh ENOENT` — an error that
 * blames the shell for a directory that simply is not there.
 */

import { statSync } from 'fs';

export interface CwdValidationResult {
    valid: boolean;
    error?: string;
}

export function validateCwd(cwd: string): CwdValidationResult {
    try {
        if (statSync(cwd).isDirectory()) {
            return { valid: true };
        }
        return { valid: false, error: `Working directory is not a directory: ${cwd}` };
    } catch (error) {
        // Report the failure we actually hit. Collapsing every stat error into
        // "does not exist" would repeat the exact mistake this module exists
        // to fix — a permission problem sent chasing a spelling problem.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return { valid: false, error: `Working directory does not exist: ${cwd}` };
        }
        return { valid: false, error: `Working directory is not accessible (${code ?? 'unknown error'}): ${cwd}` };
    }
}
