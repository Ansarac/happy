import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { redactSecrets } from './logger';

/**
 * Structurally a JWT so the redaction patterns see what they would see in
 * production, but deliberately not a credential: the payload decodes to
 * placeholders and the signature segment is plain text.
 */
const FAKE_JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZXN0Iiwic2Vzc2lvbiI6ImZha2UiLCJpc3MiOiJoYW5keSJ9.ZmFrZS1zaWduYXR1cmUtbm90LWEtcmVhbC1jcmVkZW50aWFs';

/** Exactly how logToFile renders a non-string argument. */
const renderLikeLogToFile = (value: unknown): string => inspect(value, { depth: 5, breakLength: 120 });

/**
 * Shaped after the axios failure that actually put a token on disk: an
 * archive call rejected with 401, logged whole via `logger.debug(msg, error)`.
 * The header appears twice, in the two forms axios keeps it — the parsed
 * config object and the raw request preamble.
 */
function axiosArchiveFailure(): Error {
    const error = new Error('Request failed with status code 401') as Error & Record<string, unknown>;
    error.name = 'AxiosError';
    error.code = 'ERR_BAD_REQUEST';
    error.config = {
        method: 'post',
        url: 'https://api.happy-servers.com/v1/sessions/abc123/archive',
        headers: {
            Accept: 'application/json, text/plain, */*',
            Authorization: `Bearer ${FAKE_JWT}`,
            'User-Agent': 'axios/1.18.1',
        },
    };
    error.request = {
        _header: `POST /v1/sessions/abc123/archive HTTP/1.1\r\nAccept: application/json\r\nAuthorization: Bearer ${FAKE_JWT}\r\nHost: api.happy-servers.com\r\n\r\n`,
    };
    error.response = {
        status: 401,
        statusText: 'Unauthorized',
        data: { error: 'Invalid token' },
    };
    return error;
}

describe('redactSecrets', () => {
    describe('against a rendered axios error', () => {
        it('leaks the token without redaction — the fixture is a real leak', () => {
            expect(renderLikeLogToFile(axiosArchiveFailure())).toContain('eyJ');
        });

        it('leaves no JWT fragment behind', () => {
            const scrubbed = redactSecrets(renderLikeLogToFile(axiosArchiveFailure()));
            expect(scrubbed).not.toContain('eyJ');
            expect(scrubbed).not.toContain(FAKE_JWT);
        });

        it('keeps everything that makes the error diagnosable', () => {
            const scrubbed = redactSecrets(renderLikeLogToFile(axiosArchiveFailure()));
            expect(scrubbed).toContain('Bearer [REDACTED]');
            expect(scrubbed).toContain('Request failed with status code 401');
            expect(scrubbed).toContain('https://api.happy-servers.com/v1/sessions/abc123/archive');
            expect(scrubbed).toContain('ERR_BAD_REQUEST');
        });
    });

    // The three shapes below are the ones that were actually recovered from
    // ~/.happy/logs — every leaked line matched one of them.
    describe('against the shapes observed on disk', () => {
        it('handles the inspect object form', () => {
            expect(redactSecrets(`      Authorization: 'Bearer ${FAKE_JWT}',`))
                .toBe("      Authorization: 'Bearer [REDACTED]',");
        });

        it('handles the raw request preamble form', () => {
            expect(redactSecrets(`        'Authorization: Bearer ${FAKE_JWT}\\r\\n' +`))
                .toBe("        'Authorization: Bearer [REDACTED]\\r\\n' +");
        });

        it('handles the bare header-value form', () => {
            expect(redactSecrets(`          'Bearer ${FAKE_JWT}'`))
                .toBe("          'Bearer [REDACTED]'");
        });
    });

    describe('other credential shapes', () => {
        it('redacts a bearer credential that is not JWT-shaped', () => {
            expect(redactSecrets('Bearer sk-live-0123456789abcdef')).toBe('Bearer [REDACTED]');
        });

        it('redacts a quoted token field', () => {
            expect(redactSecrets(`{ "token": "${FAKE_JWT}" }`)).toBe('{ "token": "[REDACTED]" }');
        });

        it('redacts encryption and machine key fields', () => {
            expect(redactSecrets("encryptionKey: 'ZmFrZS1rZXktbWF0ZXJpYWw='"))
                .toBe("encryptionKey: '[REDACTED]'");
            expect(redactSecrets("machineKey: 'ZmFrZS1tYWNoaW5lLWtleQ=='"))
                .toBe("machineKey: '[REDACTED]'");
        });

        it('finds a bare JWT with no surrounding structure', () => {
            expect(redactSecrets(`resume token ${FAKE_JWT} expired`)).toBe('resume token [REDACTED] expired');
        });
    });

    describe('leaves non-secrets alone', () => {
        it('does not touch unquoted numeric look-alikes', () => {
            const line = 'usage { input_tokens: 1200, output_tokens: 512 }';
            expect(redactSecrets(line)).toBe(line);
        });

        it('does not touch ordinary prose', () => {
            const line = '[14:02:11.417] [START] Reported session abc123 to daemon';
            expect(redactSecrets(line)).toBe(line);
        });

        it('is idempotent — a second pass changes nothing', () => {
            const once = redactSecrets(renderLikeLogToFile(axiosArchiveFailure()));
            expect(redactSecrets(once)).toBe(once);
        });
    });

    // logToFile runs this on every line, so a pathological input must not be
    // able to stall the process. An unterminated quote after a secret-ish key
    // is the shape that would make an unbounded quantifier backtrack.
    it('stays fast on a large line with an unterminated quote', () => {
        const line = `token: "${'a'.repeat(200_000)}`;
        const started = Date.now();
        const result = redactSecrets(line);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(result).toBe(line);
    });
});
