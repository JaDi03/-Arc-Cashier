import type { CashierConfig } from './core/types';

/**
 * Tessera Configuration
 * 
 * Dynamically loads the active connector specified in the environment (.env).
 */
const activeConnector = process.env.ACTIVE_CONNECTOR;
const upstreamUrl = process.env.UPSTREAM_URL;

const config: CashierConfig = {
    port: Number(process.env.PORT || 7878),

    connectors: activeConnector && upstreamUrl ? [
        {
            name: activeConnector,
            upstreamUrl: upstreamUrl,
        },
    ] : [],
};

export default config;
