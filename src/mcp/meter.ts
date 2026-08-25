/**
 * Per-second tool meter and watchdog for MCP tool calls.
 *
 * begin() opens a billing session in Tessera Core (HMAC ingest). While the
 * tool executes, the consumer signs Gateway ticks against
 * /api/core/stream-access at the session rate. finish() closes the session.
 * The watchdog cuts billing the moment a tool call stops responding, then
 * notifies the caller (the proxy aborts the child call).
 */

import type { Split } from '../core/types';
import { TesseraIngestClient } from './ingest';
import { SessionState } from './types';

export interface ToolMeterOptions {
    payoutAddress: string;
    ratePerSecond: number;
    splits?: Split[];
    /** Prefix for the resourceId reported to Core. Default "mcp:". */
    resourceIdPrefix?: string;
}

interface MeterEntry {
    state: SessionState;
    /** True once sessions/stop has been sent (or attempted) for this entry. */
    settled: boolean;
    watchdog: ReturnType<typeof setTimeout> | null;
    onWatchdog: (() => void) | null;
}

export class ToolMeter {
    private readonly entries = new Map<string, MeterEntry>();

    constructor(
        private readonly ingest: TesseraIngestClient,
        private readonly options: ToolMeterOptions
    ) {}

    getState(userId: string): SessionState {
        return this.entries.get(userId)?.state ?? SessionState.IDLE;
    }

    /** Opens the billing session. Throws if ingest rejects the request. */
    async begin(userId: string, toolName: string): Promise<void> {
        const existing = this.entries.get(userId);
        if (existing?.state === SessionState.METERING) {
            throw new Error(`Metering already in progress for ${userId}`);
        }

        await this.ingest.startSession({
            userId,
            resourceId: `${this.options.resourceIdPrefix ?? 'mcp:'}${toolName}`,
            ratePerSecond: this.options.ratePerSecond.toFixed(6),
            payoutAddress: this.options.payoutAddress,
            ...(this.options.splits?.length ? { splits: this.options.splits } : {}),
            metadata: { connector: 'mcp' },
        });

        this.entries.set(userId, { state: SessionState.METERING, settled: false, watchdog: null, onWatchdog: null });
    }

    /**
     * Arms the watchdog for an in-flight call. On fire the entry is marked
     * TIMEOUT, billing is cut (sessions/stop), and only then is `onFire`
     * invoked — so the proxy aborts the transport after billing stopped.
     */
    armWatchdog(userId: string, timeoutMs: number, onFire: () => void): void {
        const entry = this.entries.get(userId);
        if (!entry || entry.state !== SessionState.METERING) return;

        this.disarmWatchdog(userId);
        entry.onWatchdog = onFire;
        entry.watchdog = setTimeout(() => {
            entry.watchdog = null;
            entry.state = SessionState.TIMEOUT;
            const callback = entry.onWatchdog;
            entry.onWatchdog = null;
            void this.settle(userId).finally(() => callback?.());
        }, timeoutMs);
    }

    disarmWatchdog(userId: string): void {
        const entry = this.entries.get(userId);
        if (entry?.watchdog) {
            clearTimeout(entry.watchdog);
            entry.watchdog = null;
        }
        if (entry) entry.onWatchdog = null;
    }

    /** Cuts billing after normal completion or a local abort. Idempotent; never throws. */
    async finish(userId: string): Promise<void> {
        const entry = this.entries.get(userId);
        if (!entry) return;
        if (entry.state === SessionState.METERING) entry.state = SessionState.STOPPED;
        await this.settle(userId);
    }

    /** Marks the session TIMEOUT and cuts billing (direct-SDK wrapper path). */
    async timeout(userId: string): Promise<void> {
        const entry = this.entries.get(userId);
        if (!entry || entry.state !== SessionState.METERING) return;
        entry.state = SessionState.TIMEOUT;
        await this.settle(userId);
    }

    private async settle(userId: string): Promise<void> {
        const entry = this.entries.get(userId);
        if (!entry || entry.settled) return;
        entry.settled = true;
        this.disarmWatchdog(userId);
        try {
            await this.ingest.stopSession({ userId });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Tessera MCP] Failed to stop billing session for ${userId}: ${message}`);
        }
    }
}
