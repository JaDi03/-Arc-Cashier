import type { Express } from 'express';

export interface Split {
    address: string;
    fraction: number;
    /** For logs only. */
    label?: string;
}

/** Body of POST /api/core/v1/sessions/start. */
export interface StartSessionRequest {
    userId: string;
    /** videoId, trackId, streamId, etc. */
    resourceId: string;
    /** Decimal string in USDC, e.g. "0.000100". "0" is valid (tip-only mode). */
    ratePerSecond: string;
    payoutAddress: string;
    /** Sum of fractions must be <= 1. */
    splits?: Split[];
    metadata?: Record<string, string>;
}

/** Body of POST /api/core/v1/sessions/stop. */
export interface StopSessionRequest {
    userId: string;
}

/** Body of POST /api/core/v1/tips. */
export interface TipRequest {
    userId: string;
    payoutAddress: string;
    /** Decimal string in USDC, e.g. "0.100000". */
    amount: string;
}

/**
 * Interface every connector must implement.
 * Translates platform events into calls to the core's HTTP contract:
 *   POST /api/core/v1/sessions/start
 *   POST /api/core/v1/sessions/stop
 *   POST /api/core/v1/tips
 */
export interface Connector {
    readonly name: string;
    register(app: Express, config: ConnectorConfig): void;
}

export interface ConnectorConfig {
    name: string;
    upstreamUrl: string;
    ratePerSecond?: number;
    /** Default payee for single-operator connectors (e.g. Owncast). */
    payoutAddress?: string;
}

export interface CashierConfig {
    port?: number;
    sellerAddress?: string;
    connectors: ConnectorConfig[];
}
