import type { CashierConfig } from './core/types';

/**
 * Tessera Configuration
 * 
 * Enable or disable connectors by adding/removing them from the list.
 * Only connectors listed here will be loaded at startup.
 */
const config: CashierConfig = {
    port: 3000,

    connectors: [
        // {
        //     name: 'owncast',
        //     upstreamUrl: 'http://127.0.0.1:8080',
        //     ratePerSecond: 0.0001, // $0.0001 USDC per second (~$0.36/hour)
        // },

        // To add a new connector, uncomment and configure:
        {
            name: 'peertube',
            upstreamUrl: 'http://localhost:9000',
            ratePerSecond: 0.0001,
        },
    ],
};

export default config;
