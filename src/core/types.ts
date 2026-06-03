import type { Express } from 'express';

/**
 * Connector Interface
 * 
 * Every platform connector (Owncast, PeerTube, Jellyfin, etc.) must implement
 * this interface. The engine loads connectors from `cashier.config.ts` and calls
 * `register()` to mount them onto the Express app.
 * 
 * A connector is responsible for:
 * 1. Translating the platform's native events (webhooks, WebSockets, etc.)
 *    into `sessionService.recordJoin()` / `recordPartAndSettle()` calls.
 * 2. Optionally injecting a paywall UI into the platform's web interface.
 * 3. Optionally proxying the platform's traffic through the sidecar.
 */
export interface Connector {
    /** Human-readable name for logs (e.g., "Owncast", "PeerTube") */
    readonly name: string;

    /**
     * Register this connector's routes, webhooks, proxy, and static assets
     * onto the Express application.
     * 
     * @param app - The Express application instance
     * @param config - The connector-specific configuration from cashier.config.ts
     */
    register(app: Express, config: ConnectorConfig): void;
}

/**
 * Configuration for a single connector instance.
 */
export interface ConnectorConfig {
    /** Connector identifier matching the directory name in src/connectors/ */
    name: string;

    /** The upstream platform URL (e.g., "http://localhost:8080" for Owncast) */
    upstreamUrl: string;

    /** Per-second rate in USDC (default: 0.0001) */
    ratePerSecond?: number;
}

/**
 * Top-level configuration for the Arc Cashier engine.
 */
export interface CashierConfig {
    /** Port the sidecar listens on (default: 3000) */
    port?: number;

    /** Seller wallet address for receiving payments (overridden by SELLER_ADDRESS env var) */
    sellerAddress?: string;

    /** List of connectors to activate */
    connectors: ConnectorConfig[];
}
