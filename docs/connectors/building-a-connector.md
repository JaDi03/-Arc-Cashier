# Building a Connector

This guide walks you through adding support for a new streaming platform to Tessera. A connector is a lightweight adapter (~100 lines) that translates your platform's presence events into Tessera's billing engine.

## Prerequisites

- Your platform must emit some form of "user joined" and "user left" events (webhooks, WebSocket messages, API polling, etc.).
- You should understand how your platform tracks viewer presence.

## The Core Concept: Mapping Events to Endpoints

Tessera's core infrastructure is platform-agnostic. It provides fixed billing functions, and your connector's job is simply to translate your platform's native events into the appropriate Tessera payment model. 

Every platform emits different signals. A music server emits a "scrobble" when a track is played. A live-streaming server fires a webhook when a viewer joins. A photo gallery resolves a shared link. As a developer, you decide which Tessera payment model best fits your platform's events:

### Option A: Continuous Streaming (Per-Second)
Best for: Live streams, Video-on-Demand, or time-based access.
- **Start the meter:** Call `sessionService.recordJoin(userId, videoId, ratePerSecond, creatorAddress)` when the user starts consuming. (The `ratePerSecond` and `creatorAddress` allow you to dynamically price the stream and route funds directly to the specific creator).
- **Stop the meter:** Call `sessionService.recordPartAndSettle(userId)` when the user leaves or playback stops.

### Option B: One-Off Payments & Tips
Best for: Voluntary donations, per-article purchases, photo downloads, or event-driven micro-licenses (e.g., a music scrobble).
- **Trigger a Payment:** Your frontend or connector can call `POST /api/core/tip` with the `userId`, `creatorWallet`, and `amount`.
- This executes a one-time, off-chain settlement directly from the user's Gateway balance to the creator.

You can implement either of these models, or both, depending on what data structures and events your platform exposes.

## The Frontend & Identity Concept

Tessera provides a universal, platform-agnostic UI (`src/ui/paywall.js`) that handles wallets, CCTP bridging, and Circle sessions. You do not need to build a crypto frontend from scratch.

Your connector has two responsibilities regarding the frontend:
1. **Serve and Inject:** Serve the `src/ui` directory as static assets and inject the script into your platform's HTML response using a reverse proxy. The reverse proxy will route traffic to your platform's `upstreamUrl` (defined in the configuration).
2. **Identity Synchronization (The `userId` rule):** If your platform tracks users, you must ensure that the `userId` in the frontend exactly matches the `userId` emitted by your backend webhooks. You can do this by injecting `window.PLATFORM_USER_ID = 'user_123'` into the HTML before the paywall loads. If left undefined, the paywall generates an anonymous local ID, which is fine for anonymous tips but will not map correctly to backend presence events.

## Step 1: Create the Connector Directory

```
src/connectors/
└── your-platform/
    ├── index.ts        # Implements the Connector interface
    ├── webhooks.ts     # Translates platform events → engine calls
    └── public/         # (Optional) Frontend paywall assets
```

## Step 2: Implement the Connector Interface

Create `src/connectors/your-platform/index.ts`:

```typescript
import express from 'express';
import path from 'path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as cheerio from 'cheerio';
import type { Connector, ConnectorConfig } from '../../core/types';
import { sessionService } from '../../core/session';

const myConnector: Connector = {
    name: 'YourPlatform',

    register(app: express.Express, config: ConnectorConfig): void {
        // 1. Serve the universal frontend paywall assets
        app.use('/your-platform-assets', express.static(path.join(__dirname, '..', '..', 'ui')));

        // 2. Register your webhook/event listener
        app.post('/api/connectors/your-platform/webhook', (req, res) => {
            const { event, userId } = req.body;

            if (event === 'viewer_joined') {
                sessionService.recordJoin(userId);
            } else if (event === 'viewer_left') {
                sessionService.recordPartAndSettle(userId).catch(console.error);
            }

            res.json({ status: 'ok' });
        });

        // 3. Set up a reverse proxy using config.upstreamUrl to inject the paywall
        app.use('/', createProxyMiddleware({
            target: config.upstreamUrl,
            changeOrigin: true,
            selfHandleResponse: true,
            on: {
                proxyRes: async (responseBuffer, proxyRes, req, res) => {
                    const contentType = proxyRes.headers['content-type'];
                    if (contentType && contentType.includes('text/html')) {
                        const html = responseBuffer.toString('utf8');
                        const $ = cheerio.load(html);
                        
                        // Inject the identity and the paywall script
                        $('body').append(`<script>window.PLATFORM_USER_ID = 'dynamic_user_id_here';</script>`);
                        $('body').append(`<script src="/your-platform-assets/paywall.js"></script>`);
                        
                        const modifiedHtml = $.html();
                        res.setHeader('Content-Length', Buffer.byteLength(modifiedHtml));
                        return modifiedHtml;
                    }
                    return responseBuffer;
                }
            }
        }));
    }
};

export default myConnector;
```

The two critical calls are:
- `sessionService.recordJoin(userId)` - starts the billing meter
- `sessionService.recordPartAndSettle(userId)` - stops the meter, calculates cost, refunds remaining balance

Everything else (Gateway deposit, x402 payment, withdrawal) is handled automatically by the core engine.

## Step 3: Register in the Connector Registry

Add one line to `src/server.ts`:

```typescript
const CONNECTOR_REGISTRY: Record<string, () => Promise<{ default: Connector }>> = {
    owncast: () => import('./connectors/owncast'),
    'your-platform': () => import('./connectors/your-platform'), // ← add this
};
```

## Step 4: Enable in Config

Add your connector to `src/tessera.config.ts`:

```typescript
connectors: [
    {
        name: 'your-platform',
        upstreamUrl: 'http://localhost:9000',
        ratePerSecond: 0.0001,
    },
],
```

## Step 5: Test

1. Start your platform
2. Start Tessera: `npx ts-node src/index.ts`
3. Trigger a "viewer joined" event from your platform
4. Verify `[Session] 🟢 Session started` appears in the terminal
5. Trigger a "viewer left" event
6. Verify `[Session] 🔴 User parted` and `[Session] ✅ Refund complete` appear

## Step 6: Multi-Tenant Architecture Rules

To ensure Tessera can run multiple connectors simultaneously (e.g., Owncast and PeerTube on the same server) without routing collisions, you **MUST** adhere to these two architectural rules:

1. **Asset Routing Convention:** Any frontend assets (like `paywall.js` or `paywall.css`) must be served under a route named exactly `/[your-platform-name]-assets`. The core reverse proxies automatically ignore any routes matching `/*-assets/` to prevent swallowing requests meant for other connectors.
2. **Reverse Proxy Limitations:** While Tessera can run 10 connectors simultaneously, **only one** connector can mount a global catch-all reverse proxy (`app.use('/')`) per instance. If your platform requires a root proxy (like Owncast), users cannot enable another platform that *also* requires a root proxy on the same Tessera port.

## Reference: Owncast Connector

The Owncast connector in `src/connectors/owncast/` is the reference implementation. It demonstrates:

| File | Purpose |
|---|---|
| `index.ts` | Implements `Connector` interface, mounts routes + proxy |
| `webhooks.ts` | Translates Owncast's `USER_JOINED` / `USER_PARTED` webhooks |
| `proxy.ts` | Reverse proxy that injects `paywall.js` into Owncast's HTML |
| `types.ts` | TypeScript types matching Owncast's Go webhook structs |
| `public/paywall.js` | Browser-side paywall (MetaMask connect, deposit, session UI) |
| `public/paywall.css` | Paywall styling |

