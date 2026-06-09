# Building a Connector

This guide walks you through adding support for a new streaming platform to Arc Cashier. A connector is a lightweight adapter (~100 lines) that translates your platform's presence events into Arc Cashier's billing engine.

## Prerequisites

- Your platform must emit some form of "user joined" and "user left" events (webhooks, WebSocket messages, API polling, etc.).
- You should understand how your platform tracks viewer presence.

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
import type { Connector, ConnectorConfig } from '../../core/types';
import { sessionService } from '../../core/session';

const myConnector: Connector = {
    name: 'YourPlatform',

    register(app: express.Express, config: ConnectorConfig): void {
        // Register your webhook/event listener
        app.post('/api/connectors/your-platform/webhook', (req, res) => {
            const { event, userId } = req.body;

            if (event === 'viewer_joined') {
                sessionService.recordJoin(userId);
            } else if (event === 'viewer_left') {
                sessionService.recordPartAndSettle(userId).catch(console.error);
            }

            res.json({ status: 'ok' });
        });

        // (Optional) Serve frontend paywall assets
        app.use('/your-platform-assets', express.static(path.join(__dirname, 'public')));

        // (Optional) Set up a reverse proxy to inject paywall into your platform's UI
        // See src/connectors/owncast/proxy.ts for an example using http-proxy-middleware + cheerio
    }
};

export default myConnector;
```

The two critical calls are:
- `sessionService.recordJoin(userId)` — starts the billing meter
- `sessionService.recordPartAndSettle(userId)` — stops the meter, calculates cost, refunds remaining balance

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

Add your connector to `src/cashier.config.ts`:

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
2. Start Arc Cashier: `npx ts-node src/index.ts`
3. Trigger a "viewer joined" event from your platform
4. Verify `[Session] 🟢 Session started` appears in the terminal
5. Trigger a "viewer left" event
6. Verify `[Session] 🔴 User parted` and `[Session] ✅ Refund complete` appear

## Step 6: Multi-Tenant Architecture Rules

To ensure Arc-Cashier can run multiple connectors simultaneously (e.g., Owncast and PeerTube on the same server) without routing collisions, you **MUST** adhere to these two architectural rules:

1. **Asset Routing Convention:** Any frontend assets (like `paywall.js` or `paywall.css`) must be served under a route named exactly `/[your-platform-name]-assets`. The core reverse proxies automatically ignore any routes matching `/*-assets/` to prevent swallowing requests meant for other connectors.
2. **Reverse Proxy Limitations:** While Arc-Cashier can run 10 connectors simultaneously, **only one** connector can mount a global catch-all reverse proxy (`app.use('/')`) per instance. If your platform requires a root proxy (like Owncast), users cannot enable another platform that *also* requires a root proxy on the same Arc-Cashier port.

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

## Platform Ideas

Platforms with clean webhook/event surfaces that would make good connectors:

| Platform | Presence Signal | Stars |
|---|---|---|
| **Jellyfin** | Session API (polling) | 47.9k |
| **PeerTube** | ActivityPub / Webhooks | 14.6k |
| **Navidrome** | Subsonic API (scrobbling) | 13.2k |
| **Funkwhale** | API events | 1.8k |
