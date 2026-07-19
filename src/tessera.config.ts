import type { CashierConfig } from './core/types';

/**
 * Tessera Configuration
 * 
 * Enable or disable connectors by adding/removing them from the list.
 * Only connectors listed here will be loaded at startup.
 */
const config: CashierConfig = {
    port: 7878,

    connectors: [
        {
            name: 'peertube',
            upstreamUrl: 'http://localhost:9000',
        },
    ],
};

export default config;
