/**
 * Proxy support for outbound socket connections.
 *
 * `axios` honours the standard `http_proxy` / `https_proxy` environment
 * variables out of the box, but `socket.io-client` (via `ws`) does not — it
 * opens a direct connection unless an explicit `agent` is supplied. On networks
 * where direct egress is blocked or transparently intercepted, that makes the
 * realtime connection fail while plain REST calls keep working: the daemon
 * looks healthy locally, but every client sees it as offline.
 */
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import type { Agent } from 'node:http';

/**
 * Resolve the proxy agent to use when connecting to `targetUrl`, or
 * `undefined` when the connection should be made directly.
 *
 * Respects `http_proxy`, `https_proxy`, `all_proxy` and `no_proxy`
 * (either case), as implemented by `proxy-from-env`.
 */
export function getProxyAgent(targetUrl: string): Agent | undefined {
    // `getProxyForUrl` selects the environment variable by the URL's protocol,
    // so a `ws://` / `wss://` URL would look for `ws_proxy` / `wss_proxy`
    // instead of the `http_proxy` / `https_proxy` pair every other tool uses.
    // Normalise first: `ws://` -> `http://`, `wss://` -> `https://`.
    const normalizedUrl = targetUrl.replace(/^ws/, 'http');

    const proxyUrl = getProxyForUrl(normalizedUrl);
    if (!proxyUrl) {
        return undefined;
    }

    return new HttpsProxyAgent(proxyUrl);
}

/**
 * Same as {@link getProxyAgent}, but typed for `socket.io-client`'s `agent`
 * option.
 *
 * engine.io-client documents that option as "`http.Agent` to use (NodeJS
 * only)" yet declares it as `string | boolean`, noting: "the type should be
 * `undefined | http.Agent | https.Agent | false`, but this would break
 * browser-only clients". At runtime the Node websocket transport forwards the
 * value verbatim to `ws`, so passing an Agent is correct — only the declared
 * type is too narrow.
 */
export function getSocketIoProxyAgent(targetUrl: string): string | boolean | undefined {
    return getProxyAgent(targetUrl) as unknown as string | boolean | undefined;
}
