import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, Text } from 'ink';

/**
 * Every ink UI (auth selector, daemon prompt, remote mode displays) breaks with
 * "Cannot read properties of null (reading 'useState')" when the CLI's react
 * and the react that ink's reconciler drives are two physical copies.
 *
 * In the monorepo that happens whenever happy-cli resolves a different react
 * version than happy-app: pnpm's hoisted linker (with auto-install-peers)
 * treats ink's react peer as a regular dependency, so it nests a private copy
 * under ink instead of sharing happy-cli's. That is why happy-cli pins react
 * to happy-app's exact version — keep the two in lockstep.
 */
describe('ink and happy-cli share one react instance', () => {
    it('resolves react to the same file from happy-cli, ink and react-reconciler', () => {
        const fromCli = createRequire(import.meta.url);
        const fromInk = createRequire(fromCli.resolve('ink'));
        const fromReconciler = createRequire(fromInk.resolve('react-reconciler'));

        const cliReact = realpathSync(fromCli.resolve('react'));
        expect(realpathSync(fromInk.resolve('react'))).toBe(cliReact);
        expect(realpathSync(fromReconciler.resolve('react'))).toBe(cliReact);
    });

    it('renders a component that uses hooks', async () => {
        let output = '';
        const stdout = Object.assign(
            new Writable({
                write(chunk, _encoding, callback) {
                    output += chunk.toString();
                    callback();
                },
            }),
            { columns: 80, rows: 24, isTTY: false },
        ) as unknown as NodeJS.WriteStream;

        const Probe = () => {
            const [value] = React.useState('hooks ok');
            return React.createElement(Text, null, value);
        };

        const app = render(React.createElement(Probe), {
            stdout,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        });
        app.unmount();
        await app.waitUntilExit();

        expect(output).toContain('hooks ok');
    });
});
