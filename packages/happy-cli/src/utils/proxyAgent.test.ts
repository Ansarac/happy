/**
 * Unit tests for outbound proxy agent resolution
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getProxyAgent } from './proxyAgent';

const PROXY_ENV_KEYS = [
    'http_proxy', 'HTTP_PROXY',
    'https_proxy', 'HTTPS_PROXY',
    'all_proxy', 'ALL_PROXY',
    'no_proxy', 'NO_PROXY'
];

describe('getProxyAgent', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = {};
        for (const key of PROXY_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of PROXY_ENV_KEYS) {
            if (savedEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = savedEnv[key];
            }
        }
    });

    it('returns undefined when no proxy is configured', () => {
        expect(getProxyAgent('https://api.example.com')).toBeUndefined();
    });

    it('returns an agent when https_proxy is set', () => {
        process.env.https_proxy = 'http://proxy.local:3128';
        expect(getProxyAgent('https://api.example.com')).toBeDefined();
    });

    it('returns an agent when http_proxy is set', () => {
        process.env.http_proxy = 'http://proxy.local:3128';
        expect(getProxyAgent('http://api.example.com')).toBeDefined();
    });

    // Regression guard: proxy-from-env picks the environment variable by
    // protocol, so passing a ws:// URL through unchanged would look for
    // `ws_proxy` and silently resolve to no proxy at all.
    it('maps wss:// to https_proxy', () => {
        process.env.https_proxy = 'http://proxy.local:3128';
        expect(getProxyAgent('wss://api.example.com')).toBeDefined();
    });

    it('maps ws:// to http_proxy', () => {
        process.env.http_proxy = 'http://proxy.local:3128';
        expect(getProxyAgent('ws://api.example.com')).toBeDefined();
    });

    it('honours no_proxy', () => {
        process.env.https_proxy = 'http://proxy.local:3128';
        process.env.no_proxy = 'api.example.com';
        expect(getProxyAgent('https://api.example.com')).toBeUndefined();
    });

    it('honours no_proxy for wss:// targets', () => {
        process.env.https_proxy = 'http://proxy.local:3128';
        process.env.no_proxy = 'api.example.com';
        expect(getProxyAgent('wss://api.example.com')).toBeUndefined();
    });
});
