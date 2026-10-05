/**
 * Design decisions:
 * - Logging should be done only through file for debugging, otherwise we might disturb the claude session when in interactive mode
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: ~/.handy/logs/<date time in local timezone>.log
 */

import chalk from 'chalk'
import { appendFileSync } from 'fs'
import { inspect } from 'node:util'
import { configuration } from '@/configuration'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
// Note: readDaemonState is imported lazily inside listDaemonLogFiles() to avoid
// circular dependency: logger.ts ↔ persistence.ts

const REDACTED = '[REDACTED]'

/**
 * Credentials reach the logs by accident, not by design: `logToFile` renders
 * arbitrary arguments with `inspect(..., { depth: 5 })`, so one
 * `logger.debug('request failed:', axiosError)` is enough to write the whole
 * request — `Authorization` header included — to disk, and to ship it to
 * `dangerouslyUnencryptedServerLoggingUrl` in plaintext.
 *
 * Scrubbing the rendered string rather than the object graph is deliberate:
 * the string is the single chokepoint every log path funnels through, it
 * cannot trip over circular references, getters or exotic prototypes, and it
 * catches every shape `inspect` produces for the same header — the array form
 * (`authorization: [ 'Authorization', 'Bearer …' ]`), the object form and the
 * JSON form alike.
 */
export function redactSecrets(text: string): string {
    return text
        // JWTs first: this catches the token wherever it appears, including
        // inside a Bearer prefix, and leaves the surrounding structure intact.
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED)
        // Any remaining bearer credential that is not JWT-shaped.
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
        // Quoted secret-ish fields. The value must be quoted, so numeric
        // look-alikes such as `output_tokens: 512` are left alone. The length
        // is bounded rather than open-ended: an unterminated quote in a large
        // inspect() dump would otherwise make the engine backtrack across the
        // whole line, once per starting position.
        .replace(
            /(["']?\b(?:token|access_?token|refresh_?token|encryption_?key|machine_?key|private_?key|api_?key|secret|password)\b["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\]){1,4096}\2/gi,
            `$1$2${REDACTED}$2`,
        )
}

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/[: ]/g, '-').replace(/,/g, '') + '-pid-' + process.pid
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', { 
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}-daemon.log` : `${timestamp}.log`
  return join(configuration.logsDir, filename)
}

// Exported for tests, which construct one against a temp path so they can
// assert on the created file without touching the real log directory.
export class Logger {
  private dangerouslyUnencryptedServerLoggingUrl: string | undefined

  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    // Remote logging enabled only when explicitly set with server URL
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING 
      && process.env.HAPPY_SERVER_URL) {
      this.dangerouslyUnencryptedServerLoggingUrl = process.env.HAPPY_SERVER_URL
      console.log(chalk.yellow('[REMOTE LOGGING] Sending logs to server for AI debugging'))
    }
  }

  // Use local timezone for simplicity of locating the logs,
  // in practice you will not need absolute timestamps
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry()
  }

  debug(message: string, ...args: unknown[]): void {
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)

    // NOTE: @kirill does not think its a good ideas,
    // as it will break us using claude in interactive mode.
    // Instead simply open the debug file in a new editor window.
    //
    // Also log to console in development mode
    // if (process.env.DEBUG) {
    //   this.logToConsole('debug', '', message, ...args)
    // }
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10,
  ): void {
    if (!process.env.DEBUG) {
      this.debug(`In production, skipping message inspection`)
    }

    // Some of our messages are huge, but we still want to show them in the logs
    const truncateStrings = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return obj.length > maxStringLength 
          ? obj.substring(0, maxStringLength) + '... [truncated for logs]'
          : obj
      }
      
      if (Array.isArray(obj)) {
        const truncatedArray = obj.map(item => truncateStrings(item)).slice(0, maxArrayLength)
        if (obj.length > maxArrayLength) {
          truncatedArray.push(`... [truncated array for logs up to ${maxArrayLength} items]` as unknown)
        }
        return truncatedArray
      }
      
      if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'usage') {
            // Drop usage, not generally useful for debugging
            continue
          }
          result[key] = truncateStrings(value)
        }
        return result
      }
      
      return obj
    }

    const truncatedObject = truncateStrings(object)
    const json = JSON.stringify(truncatedObject, null, 2)
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, '\n', json)
  }
  
  info(message: string, ...args: unknown[]): void {
    this.logToConsole('info', '', message, ...args)
    this.debug(message, args)
  }
  
  infoDeveloper(message: string, ...args: unknown[]): void {
    // Always write to debug
    this.debug(message, ...args)
    
    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole('info', '[DEV]', message, ...args)
    }
  }
  
  warn(message: string, ...args: unknown[]): void {
    this.logToConsole('warn', '', message, ...args)
    this.debug(`[WARN] ${message}`, ...args)
  }
  
  getLogPath(): string {
    return this.logFilePath
  }
  
  private logToConsole(level: 'debug' | 'error' | 'info' | 'warn', prefix: string, message: string, ...args: unknown[]): void {
    // Separate path from logToFile, and normally transient — but a daemon's
    // stdout can be redirected to a file, so it gets the same scrubbing.
    //
    // Object args keep their native console formatting (colors, depth) unless
    // the rendered form actually carries a secret; only then are they swapped
    // for a pre-rendered redacted string. Pre-rendering everything would
    // degrade every console line to pay for the rare one that leaks.
    const safeMessage = redactSecrets(message)
    const safeArgs = args.map(arg => {
      if (typeof arg === 'string') return redactSecrets(arg)
      const rendered = inspect(arg, { depth: 5, breakLength: 120 })
      const redacted = redactSecrets(rendered)
      return redacted === rendered ? arg : redacted
    })

    switch (level) {
      case 'debug': {
        console.log(chalk.gray(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'error': {
        console.error(chalk.red(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'info': {
        console.log(chalk.blue(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'warn': {
        console.log(chalk.yellow(prefix), safeMessage, ...safeArgs)
        break
      }

      default: {
        this.debug('Unknown log level:', level)
        console.log(chalk.blue(prefix), safeMessage, ...safeArgs)
        break
      }
    }
  }

  private async sendToRemoteServer(level: string, message: string, ...args: unknown[]): Promise<void> {
    if (!this.dangerouslyUnencryptedServerLoggingUrl) return
    
    try {
      await fetch(this.dangerouslyUnencryptedServerLoggingUrl + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: redactSecrets(`${message} ${args.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
          ).join(' ')}`),
          source: 'cli',
          platform: process.platform
        })
      })
    } catch (error) {
      // Silently fail to avoid disrupting the session
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const logLine = redactSecrets(`${prefix} ${message} ${args.map(arg =>
      typeof arg === 'string' ? arg : inspect(arg, { depth: 5, breakLength: 120 })
    ).join(' ')}\n`)

    // Send to remote server if configured
    if (this.dangerouslyUnencryptedServerLoggingUrl) {
      // Determine log level from prefix
      let level = 'info'
      if (prefix.includes(this.localTimezoneTimestamp())) {
        level = 'debug'
      }
      // Fire and forget, with explicit .catch to prevent unhandled rejection
      this.sendToRemoteServer(level, message, ...args).catch(() => {
        // Silently ignore remote logging errors to prevent loops
      })
    }
    
    // Handle async file path
    try {
      // `mode` applies only when this call creates the file — which is the
      // common case, since every process logs to its own timestamped path.
      // Without it the file lands at 0o666 & ~umask, i.e. 0644 on a default
      // umask: world-readable, on machines that may well have other users.
      // Redaction (redactSecrets) keeps credentials out; this keeps everything
      // else — cwd, prompts, tool output — out of a co-tenant's reach.
      appendFileSync(this.logFilePath, logLine, { mode: 0o600 })
    } catch (appendError) {
      if (process.env.DEBUG) {
        console.error('[DEV MODE ONLY THROWING] Failed to append to log file:', appendError)
        throw appendError
      }
      // In production, fail silently to avoid disturbing Claude session
    }
  }
}

// Will be initialized immideately on startup
export let logger = new Logger()

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
export async function listDaemonLogFiles(limit: number = 50): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith('-daemon.log'))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      // Lazy import to avoid circular dependency: logger.ts ↔ persistence.ts
      const { readDaemonState } = await import('@/persistence');
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
