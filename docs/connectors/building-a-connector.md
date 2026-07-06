# Building a Connector

This guide walks you through adding support for a new platform to Tessera. A connector is a lightweight adapter (~50 lines of TypeScript) that translates your platform's event and lifecycle signals into Tessera's core billing engine.

## Prerequisites

- Your platform must support plugins, custom scripts, or outbound webhook notifications.
- You should understand how the platform tracks active consumption sessions.

## The Core Concept: Mapping Events to Endpoints

Tessera's core infrastructure is platform-agnostic. It provides fixed billing functions, and your connector's job is simply to translate your platform's native events into the appropriate Tessera payment model. 

Every platform emits different signals. A music server emits an event when a track is played. A video platform fires a webhook when a viewer starts watching. A blog platform calls an endpoint when an article is loaded. As a developer, you decide which Tessera payment model best fits your platform's events:

### Option A: Continuous Streaming (Per-Second)
Best for: Live streams, Video-on-Demand, or time-based access.
- **Start the meter:** Call `sessionService.recordJoin(userId, contentId, ratePerSecond, creatorAddress)` when the user starts consuming. (The `ratePerSecond` and `creatorAddress` allow you to dynamically price the stream and route funds directly to the specific creator).
- **Stop the meter:** Call `sessionService.recordPartAndSettle(userId)` when the user leaves or consumption stops.

### Option B: One-Off Payments & Tips
Best for: Voluntary donations, per-article purchases, downloads, or event-driven micro-licenses.
- **Trigger a Payment:** Your frontend or connector can call `POST /api/core/tip` with the `userId`, `creatorWallet`, and `amount`.
- This executes a one-time, off-chain settlement directly from the user's Gateway balance to the creator.

You can implement either of these models, or both, depending on what data structures and events your platform exposes.

## The Frontend & Identity Concept

Tessera provides a universal, platform-agnostic UI (`paywall.js` & `paywall.css`) that handles wallets, CCTP bridging, and Circle sessions. You do not need to build a crypto frontend from scratch.

Your connector has two responsibilities regarding the frontend:
1. **Serve static assets:** Serve the `src/ui` directory as static assets to be loaded by the platform client.
2. **Identity Synchronization (The `userId` rule):** If your platform tracks users, you must ensure that the `userId` in the frontend matches the `userId` emitted by your backend webhooks. You can do this by setting `window.PLATFORM_USER_ID` or passing it when initializing the paywall.

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
        // 1. Serve the universal frontend paywall assets
        app.use('/your-platform-assets', express.static(path.join(__dirname, '..', '..', 'ui')));

        // 2. Register webhook/API handler for platform events
        app.post('/api/connectors/your-platform/events', (req, res) => {
            const { event, userId, rate, wallet, contentId } = req.body;

            if (event === 'join') {
                // Starts the billing session
                sessionService.recordJoin(userId, contentId, rate, wallet);
            } else if (event === 'leave') {
                // Ends and settles the session
                sessionService.recordPartAndSettle(userId).catch(console.error);
            }

            res.json({ status: 'ok' });
        });
    }
};

export default myConnector;
```

The two critical calls are:
- `sessionService.recordJoin(userId)` - starts the billing meter
- `sessionService.recordPartAndSettle(userId)` - stops the meter, calculates cost, and settles remaining balance

Everything else (Gateway deposit, x402 payment, withdrawal) is handled automatically by the core engine.

## Step 3: Register in the Connector Registry

Add your connector import to `src/server.ts`:

```typescript
const CONNECTOR_REGISTRY: Record<string, () => Promise<{ default: Connector }>> = {
    'your-platform': () => import('./connectors/your-platform'), // ← add this
};
```

## Step 4: Enable in Config

Add your connector configuration to `src/tessera.config.ts`:

```typescript
connectors: [
    {
        name: 'your-platform',
        ratePerSecond: 0.0001,
    },
],
```

## Step 5: Test

1. Start your platform.
2. Start Tessera: `npm run dev` (or equivalent start script).
3. Trigger a "join" event from your platform plugin or backend.
4. Verify `[Session] 🟢 Session started` appears in the terminal.
5. Trigger a "leave" event.
6. Verify `[Session] 🔴 User parted` and `[Session] ✅ Refund complete` appear.

## Step 6: Multi-Tenant Architecture Rules

To ensure Tessera can run multiple connectors simultaneously without routing collisions, you **MUST** adhere to this routing convention:

1. **Asset Routing Convention:** Any frontend assets (like `paywall.js` or `paywall.css`) must be served under a route named exactly `/[your-platform-name]-assets`. The core server uses this format to isolate assets for different platforms.
