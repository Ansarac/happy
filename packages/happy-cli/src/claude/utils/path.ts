import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function getProjectsRoot() {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects');
}

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    return join(getProjectsRoot(), projectId);
}

/**
 * Locate a session's transcript file.
 *
 * Claude Code keys transcripts by the session's cwd, but the cwd can change
 * mid-session: EnterWorktree moves the transcript into the worktree's project
 * directory and appends a `relocated` record. Session ids are UUIDs, so when
 * the file is not under the starting directory we look for it under every
 * project directory. Falls back to the starting directory's path, which is
 * where a transcript that does not exist yet will be created.
 */
export function resolveSessionFile(workingDirectory: string, sessionId: string): string {
    const expected = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`);
    if (existsSync(expected)) {
        return expected;
    }
    const projectsRoot = getProjectsRoot();
    let entries: string[];
    try {
        entries = readdirSync(projectsRoot);
    } catch {
        return expected;
    }
    for (const entry of entries) {
        const candidate = join(projectsRoot, entry, `${sessionId}.jsonl`);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return expected;
}

/**
 * The project directory that holds a session's transcript. A fork written
 * here sits next to its source, wherever EnterWorktree moved that.
 */
export function getSessionProjectPath(workingDirectory: string, sessionId: string): string {
    return dirname(resolveSessionFile(workingDirectory, sessionId));
}
