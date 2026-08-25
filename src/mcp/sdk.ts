/**
 * withTesseraMeter: wrap a @modelcontextprotocol/sdk CallToolRequest handler
 * with per-second Tessera billing — for developers writing MCP servers
 * directly in TypeScript instead of wrapping a child process.
 *
 * No SDK import is required: the wrapper is structurally typed, so it works
 * with any handler shaped like (request, extra) => Promise<result>. The
 * consumer identity is read from request.params._meta.tesseraUserId (or a
 * configured default). Billing is cut when the handler settles, when the
 * request is aborted (extra.signal), or when the watchdog fires.
 *
 * Example:
 *   server.setRequestHandler(CallToolRequestSchema, withTesseraMeter(handler, {
 *     payoutAddress: '0x...', ratePerSecond: 0.001,
 *     tesseraBaseUrl: 'http://127.0.0.1:7878',
 *     ingestSecret: process.env.TESSERA_INGEST_SECRET!,
 *   }));
 */

import type { Split } from '../core/types';
import { TesseraIngestClient } from './ingest';
import { ToolMeter } from './meter';

export interface WithTesseraMeterOptions {
    payoutAddress: string;
    ratePerSecond: number;
    tesseraBaseUrl: string;
    ingestSecret: string;
    splits?: Split[];
    /** Identity used when the request carries no `_meta.tesseraUserId`. */
    defaultUserId?: string;
    /** Cut billing if the handler runs longer than this. Default 60s. */
    watchdogTimeoutMs?: number;
}

type TesseraRequest = {
    params?: { name?: string; _meta?: { tesseraUserId?: string } };
};

type TesseraExtra = {
    signal?: AbortSignal;
};

export function withTesseraMeter<Req extends TesseraRequest, Extra extends TesseraExtra, Res>(
    handler: (request: Req, extra: Extra) => Promise<Res>,
    options: WithTesseraMeterOptions
): (request: Req, extra: Extra) => Promise<Res> {
    const meter = new ToolMeter(new TesseraIngestClient(options.tesseraBaseUrl, options.ingestSecret), {
        payoutAddress: options.payoutAddress,
        ratePerSecond: options.ratePerSecond,
        splits: options.splits,
    });

    return async (request, extra) => {
        const userId = request?.params?._meta?.tesseraUserId ?? options.defaultUserId;
        const tool = request?.params?.name ?? 'unknown-tool';
        if (!userId) {
            throw new Error(
                'Tessera: missing consumer identity — send _meta.tesseraUserId on the tools/call params or set defaultUserId.'
            );
        }

        await meter.begin(userId, tool);

        let timedOut = false;
        const watchdog = setTimeout(() => {
            timedOut = true;
            void meter.timeout(userId);
        }, options.watchdogTimeoutMs ?? 60_000);

        const onAbort = () => void meter.finish(userId);
        extra?.signal?.addEventListener('abort', onAbort, { once: true });

        try {
            return await handler(request, extra);
        } finally {
            clearTimeout(watchdog);
            extra?.signal?.removeEventListener('abort', onAbort);
            if (!timedOut) await meter.finish(userId);
        }
    };
}
