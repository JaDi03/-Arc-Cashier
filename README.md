# Arc Cashier

<div align="center">
  <p>
    <img src="https://img.shields.io/badge/build-passing-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white" alt="CI Status" />
    <img src="https://img.shields.io/badge/version-1.0.0-blue?style=for-the-badge" alt="Version" />
    <img src="https://img.shields.io/badge/license-Apache_2.0-yellow?style=for-the-badge" alt="License" />
    <img src="https://img.shields.io/badge/node-%3E%3D_22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  </p>
  <p>
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
    <img src="https://img.shields.io/badge/Circle_x402-2B3139?style=for-the-badge&logo=web3dotjs&logoColor=white" alt="Circle x402" />
  </p>
</div>

**Per-second streaming payments for self-hosted platforms, powered by Circle x402.**

> **TL;DR:** Monetize any video stream by the second. Viewers deposit USDC from any chain via CCTP, unlock the stream via gasless x402 signatures, and settle efficiently on the Arc Network. Zero modifications required to your media server.

Arc Cashier is a payment sidecar that sits between your viewers and your self-hosted streaming platform. It bills viewers by the second using [Circle Gateway](https://developers.circle.com/gateway) and the [x402 protocol](https://x402.org): gasless off-chain micropayments settled in batches on-chain.

The platform (Owncast, PeerTube, Jellyfin, etc.) never sees a wallet or a payment. It emits the same `USER_JOINED` / `USER_PARTED` events it has always emitted. Arc Cashier does the rest.

---

## Table of Contents
- [How It Works](#how-it-works)
- [Supported Platforms & Plugins](#supported-platforms--plugins)
- [Proof of Concept](#proof-of-concept)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Building a Connector](#building-a-connector)
- [Primitives for Arc Builders](#primitives-for-arc-builders)
- [Architecture & Fees](#architecture--fees)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## How It Works

```mermaid
sequenceDiagram
    actor Viewer as 👤 Viewer
    participant Browser as 🌐 paywall.js (Client)
    participant Cashier as 🛡️ Arc Cashier (Proxy)
    participant Owncast as 🎥 Owncast (Media)
    participant Gateway as 💎 Circle Gateway

    %% 1. Initial Load & Injection
    Viewer->>Cashier: GET / (Visits Stream)
    Cashier->>Owncast: Proxies Request
    Owncast-->>Cashier: Returns original HTML
    Note over Cashier,Browser: Arc Cashier injects paywall script
    Cashier-->>Viewer: HTML + Injected paywall.js
    
    %% 2. Deposit & Connection
    Viewer->>Browser: Clicks "Connect Wallet & Deposit"
    Browser->>Gateway: Transfers Initial Guarantee to Contract
    Gateway-->>Browser: Deposit Confirmed
    
    %% 3. Session Registration
    Browser->>Cashier: POST /api/core/register-session
    Note over Browser,Cashier: Transmits Ephemeral Private Key
    Cashier-->>Browser: 200 OK (Session Started)
    
    %% 4. Consumption (x402 streaming)
    loop While watching stream (Per Second)
        Note over Browser,Cashier: Silent x402 Micropayments
    end
    
    %% 5. Withdrawal & End
    Viewer->>Browser: Clicks "End Session & Withdraw"
    Browser->>Cashier: POST /api/core/end-session (XMLHttpRequest)
    Cashier->>Gateway: Settles & Withdraws Remaining Balance (-0.5% fee)
    Gateway-->>Cashier: Withdrawal Confirmed
    Cashier-->>Browser: 200 OK (Refund Processed)
    Browser-->>Viewer: UI Shows "✅ Session Ended"
```

1. **Viewer opens stream** → Arc Cashier proxies the request to Owncast and injects the paywall overlay.
2. **Viewer deposits an initial guarantee** → Funds flow to an ephemeral wallet, then into the Circle Gateway smart contract.
3. **Session begins** → The client calls `POST /api/core/register-session` with their ephemeral key.
4. **Micropayments flow** → The system bills the viewer continuously via gasless x402 signatures.
5. **Viewer leaves** → The client triggers `POST /api/core/end-session` to immediately settle the final amount and withdraw the unused balance back to the viewer's wallet.

---

## Supported Platforms & Plugins

Arc Cashier supports multiple platforms via its connector architecture. Depending on the platform, you might need to install a companion plugin.

| Platform | Type | How to Install |
|---|---|---|
| **Owncast** | Built-in | Arc-Cashier acts as a reverse proxy. Just set your Owncast URL in `cashier.config.ts`. No extra plugins needed. |
| **PeerTube** | Official Plugin | PeerTube requires our companion plugin to send webhooks. **[Click here to download and install the PeerTube Plugin](https://github.com/JaDi03/peertube-plugin-arc-cashier)**. |

*Want to add support for Jellyfin, Navidrome, or your own app? See [Building a Connector](#building-a-connector).*

---

## Proof of Concept

**Live Demo (Viewer Flow)**  
<video src="https://github.com/user-attachments/assets/616387d0-0704-403e-93c3-1f808dd0d0ca" controls autoplay loop muted playsinline width="100%"></video>



**Backend Verification & On-Chain Settlement**  
The backend silently handles gasless x402 signatures every second, eventually settling the remainder directly on the Arc Testnet via the Circle Gateway smart contract.

<p align="center">
  <img src="media/terminal.PNG" alt="Terminal Logs" width="48%">
  &nbsp;
  <img src="media/explorer.PNG" alt="Block Explorer" width="48%">
</p>

---

## Quick Start

### Prerequisites
- Node.js v22+
- An Owncast instance (or any supported platform) running
- MetaMask with Arc Testnet USDC ([Circle Faucet](https://faucet.circle.com))

### Ideal Fork Flow (Development)

Arc Cashier provides a streamlined workflow for developers looking to fork, test, and contribute:

```bash
git clone https://github.com/JaDi03/Arc-Cashier.git
cd arc-cashier
nvm use          # Reads .nvmrc and switches to Node v22
npm install
cp .env.example .env
```

Edit `.env` and `src/cashier.config.ts` with your specific settings (see comments in the files).

Run the development server:
```bash
npm run dev      # Hot reloads using ts-node
```

### Production Deployment

For production, compile the TypeScript code to JavaScript. Using `ts-node` in production is not recommended.

```bash
npm run build    # Compiles code to dist/
npm start        # Runs production-ready js
```

Alternatively, you can use the provided `Dockerfile` to deploy a containerized instance of Arc Cashier anywhere Docker is supported.

---

## Project Structure

```
.
├── src/
│   ├── core/                        # The payment engine (platform-agnostic)
│   │   ├── types.ts                 # Connector interface: the main primitive
│   │   ├── routes.ts                # x402 Gateway integration (deposit, pay)
│   │   ├── session.ts               # Per-second billing + refund via withdraw()
│   │   ├── session.spec.ts          # Unit tests
│   │   ├── wallet.ts                # Ephemeral key management
│   │   └── wallet.spec.ts           # Unit tests
│   │
│   ├── connectors/                  # Platform adapters (plug-in architecture)
│   │   └── owncast/                 # Reference connector
│   │       ├── index.ts             # Implements Connector interface
│   │       ├── webhooks.ts          # Translates Owncast events → engine calls
│   │       ├── proxy.ts             # Reverse proxy + paywall injection
│   │       └── public/              # Frontend paywall assets
│   │
│   ├── cashier.config.ts            # Which connectors to load
│   ├── server.ts                    # Dynamic connector loader
│   └── index.ts                     # Entry point
│
├── .github/workflows/ci.yml         # GitHub Actions CI pipeline
├── docs/                            # Deep-dive documentation and guides
│   └── BUILDING_A_CONNECTOR.md      # How to build custom platform connectors
├── CONTRIBUTING.md                  # Guidelines for new developers
├── Dockerfile                       # Production container build
└── eslint.config.mjs                # Code quality rules
```

---

## Building a Connector

Arc Cashier is designed so that adding a new platform takes ~100 lines of code. See [docs/BUILDING_A_CONNECTOR.md](docs/BUILDING_A_CONNECTOR.md) for the full guide.

The short version: implement the `Connector` interface from `src/core/types.ts`:

```typescript
import type { Connector, ConnectorConfig } from '../../core/types';

const myConnector: Connector = {
    name: 'MyPlatform',
    register(app, config) {
        // 1. Listen for your platform's presence events
        // 2. Call sessionService.recordJoin(userId) on join
        // 3. Call sessionService.recordPartAndSettle(userId) on leave
    },
};

export default myConnector;
```

---

## Primitives for Arc Builders

| Primitive | Description |
|---|---|
| **Per-second billing engine** | `session.ts`: tracks presence, computes duration, settles per-second |
| **Sidecar pattern** | Monetize any platform without modifying its source code |
| **Reverse proxy injection** | Inject payment UI into upstream HTML via Cheerio |
| **Ephemeral wallet abstraction** | Disposable keys so users never expose their main private key |
| **Connector interface** | Standardized contract for adapting any webhook-emitting platform |
| **x402 Gateway lifecycle** | Full deposit → pay → withdraw flow via Circle SDK |

---

## 🏗️ Architecture & Fees

Arc-Cashier utilizes Circle CCTP and gasless x402 signatures for high-frequency, per-second micro-billing. For deep-dive architecture diagrams, transparent fee breakdowns, and settlement logic, **[read the full Architecture Guide here](docs/ARCHITECTURE.md)**.

---

## Tech Stack

- **[Circle x402-batching SDK](https://www.npmjs.com/package/@circle-fin/x402-batching)**: Gasless micropayments
- **[Viem](https://viem.sh/)**: Type-safe Ethereum interactions
- **[Express](https://expressjs.com/)**: HTTP server
- **[TypeScript](https://www.typescriptlang.org/)**: Strict typing
- **[Cheerio](https://cheerio.js.org/)**: HTML injection

## License

Apache-2.0
