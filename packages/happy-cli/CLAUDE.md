# Happy CLI Codebase Overview

## Project Overview

Happy CLI (`handy-cli`) is a command-line tool that wraps Claude Code to enable remote control and session sharing. It's part of a three-component system:

1. **handy-cli** (this project) - CLI wrapper for Claude Code
2. **handy** - React Native mobile client
3. **handy-server** - Node.js server with Prisma (hosted at https://api.happy-servers.com/)

## Code Style Preferences

### TypeScript Conventions
- **Strict typing**: No untyped code ("I despise untyped code")
- **Clean function signatures**: Explicit parameter and return types
- **As little as possible classes**
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities.
- **Import style**: Uses `@/` alias for src imports, e.g., `import { logger } from '@/ui/logger'`
- **File extensions**: Uses `.ts` for TypeScript files
- **Export style**: Named exports preferred, with occasional default exports for main functions

### DO NOT

- Create stupid small functions / getters / setters
- Excessive use of `if` statements - especially if you can avoid control flow changes with a better design
- **NEVER import modules mid-code** - ALL imports must be at the top of the file

### Error Handling
- Graceful error handling with proper error messages
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Testing
- Unit tests using Vitest
- No mocking - tests make real API calls
- Test files colocated with source files (`.test.ts`)
- Descriptive test names and proper async handling

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Special handling for large JSON objects with truncation

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles server communication and encryption.

- **`api.ts`**: Main API client class for session management
- **`apiSession.ts`**: WebSocket-based real-time session client with RPC support
- **`auth.ts`**: Authentication flow using TweetNaCl for cryptographic signatures
- **`encryption.ts`**: End-to-end encryption utilities using TweetNaCl
- **`types.ts`**: Zod schemas for type-safe API communication

**Key Features:**
- End-to-end encryption for all communications
- Socket.IO for real-time messaging
- Optimistic concurrency control for state updates
- RPC handler registration for remote procedure calls

### 2. Claude Integration (`/src/claude/`)
Core Claude Code integration layer.

- **`loop.ts`**: Main control loop managing interactive/remote modes
- **`types.ts`**: Claude message type definitions with parsers

- **`claudeSdk.ts`**: Direct SDK integration using `@anthropic-ai/claude-code`
- **`interactive.ts`**: **LIKELY WILL BE DEPRECATED in favor of running through SDK** PTY-based interactive Claude sessions
- **`watcher.ts`**: File system watcher for Claude session files (for interactive mode snooping)

- **`mcp/startPermissionServer.ts`**: MCP (Model Context Protocol) permission server

**Key Features:**
- Dual mode operation: interactive (terminal) and remote (mobile control)
- Session persistence and resumption
- Real-time message streaming
- Permission intercepting via MCP [Permission checking not implemented yet]

### 3. UI Module (`/src/ui/`)
User interface components.

- **`logger.ts`**: Centralized logging system with file output
- **`qrcode.ts`**: QR code generation for mobile authentication
- **`start.ts`**: Main application startup and orchestration

**Key Features:**
- Clean console UI with chalk styling
- QR code display for easy mobile connection
- Graceful mode switching between interactive and remote

### 4. Core Files

- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings and keys
- **`utils/time.ts`**: Exponential backoff utilities

## Data Flow

1. **Authentication**: 
   - Generate/load secret key → Create signature challenge → Get auth token

2. **Session Creation**:
   - Create encrypted session with server → Establish WebSocket connection

3. **Message Flow**:
   - Interactive mode: User input → PTY → Claude → File watcher → Server
   - Remote mode: Mobile app → Server → Claude SDK → Server → Mobile app

4. **Permission Handling**:
   - Claude requests permission → MCP server intercepts → Sends to mobile → Mobile responds → MCP approves/denies

## Key Design Decisions

1. **File-based logging**: Prevents interference with Claude's terminal UI
2. **Dual Claude integration**: Process spawning for interactive, SDK for remote
3. **End-to-end encryption**: All data encrypted before leaving the device
4. **Session persistence**: Allows resuming sessions across restarts
5. **Optimistic concurrency**: Handles distributed state updates gracefully

## Security Considerations

- Private keys stored in `~/.handy/access.key` with restricted permissions
- All communications encrypted using TweetNaCl
- Challenge-response authentication prevents replay attacks
- Session isolation through unique session IDs

## Dependencies

- Core: Node.js, TypeScript
- Claude: `@anthropic-ai/claude-code` SDK
- Networking: Socket.IO client, Axios
- Crypto: TweetNaCl
- Terminal: node-pty, chalk, qrcode-terminal
- Validation: Zod
- Testing: Vitest 


# Running the Daemon

## Starting the Daemon
```bash
# From the happy-cli directory:
./bin/happy.mjs daemon start

# With custom server URL (for local development):
HAPPY_SERVER_URL=http://localhost:3005 ./bin/happy.mjs daemon start

# Stop the daemon:
./bin/happy.mjs daemon stop

# Check daemon status:
./bin/happy.mjs daemon status
```

## Daemon Logs
- Daemon logs are stored in `~/.happy-dev/logs/` (or `$HAPPY_HOME_DIR/logs/`)
- Named with format: `YYYY-MM-DD-HH-MM-SS-daemon.log`

# Resuming vs. forking: `claude` and sdk behavior

> Scope: measured 2026-07-28 against `@anthropic-ai/claude-agent-sdk@0.3.220`,
> on the SDK path (`resume` option → `claude --resume=<id> --output-format
> stream-json --input-format stream-json`). That is the only path handy-cli
> takes. See the historical note at the bottom for the older `--print` finding
> this section replaces.

## Commands Run

### Live session, resumed by the SDK
```bash
claude --resume=16441779-… --output-format stream-json --input-format stream-json
```
- Session ID passed in: `16441779-…`
- Session ID on every line of the resumed file: `16441779-…` — **unchanged**
- File on disk: `~/.claude/projects/.../16441779-….jsonl`, appended **in place**
  (528490 B at 11:48 → 539071 B at 13:03)
- No `.jsonl` under a new UUID appeared in the project directory

## Key Findings for `--resume`

**`--resume` continues in place. It does not fork.**

### 1. Session File Behavior
- Appends to the EXISTING session file — no new file, no new session ID
- The resumed UUID stays the session's identity for the rest of its life

### 2. Session ID Rewriting
- Does not happen. Every one of the 254 lines in the resumed file carried the
  single value `sessionId: "16441779-…"`

### 3. Summary Line
- No `{"type":"summary",...}` line is inserted on resume

### 4. Context Preservation
- Unchanged from the older note: full context is preserved and the resumed
  session behaves as one continuous conversation

## `forkSession: true` — the other semantics

The new-file / new-ID / rewritten-history behavior is what
`QueryOptions.forkSession` (`sdk.d.ts:1500`) buys:

> "When true, resumed sessions will fork to a new session ID rather than
> continuing the previous session. Use with `resume`."

**handy-cli never sets it.** `src/claude/claudeRemote.ts:129` passes only
`resume: startFrom ?? undefined`, so `forkSession` takes its default of
`false` — always continue-in-place. (Not to be confused with our own
`forkSession()` in `src/claude/utils/claudeSessionFork.ts`, which is a
filesystem operation; `apiMachine.ts` imports it aliased as
`claudeForkSession` for exactly that reason.)

## Implications for handy-cli

1. The session ID in stream-json output after a resume **equals the one passed
   in**. There is no ID change to detect or map downstream.
2. The source file is **appended to** — it is not a frozen historical record.
   Anything reading it must tolerate concurrent growth.
3. "New session, old context" therefore requires copying the JSONL **at the
   filesystem level first**. That is what
   `src/claude/utils/claudeSessionFork.ts` is for. Its `copyFile` is load
   bearing: without it, `--resume` on the fork would append into the parent
   session's JSONL.
4. That copy is verbatim (`claudeSessionFork.ts:71`) — inline `sessionId`
   values are **not** rewritten to the new UUID, and the fork still resumes
   correctly. So Claude locates a session by **filename**; the `sessionId`
   field inside each line is not what it keys on.

## Historical Note

An earlier revision of this section claimed the opposite: that `--resume`
created a new file under a new ID, prefixed the full history with a summary
line, and rewrote every historical `sessionId`. That was measured on an older
Claude release using `claude --print --resume <id> '<prompt>'`, and that exact
command was **not** re-run for the 2026-07-28 check. The findings above are
scoped to the SDK path — the only one handy-cli exercises. If you need the
`--print` behavior, re-measure it rather than assuming either description
applies.