<div align="center" markdown="1">

<img src="assets/logo_yellow.svg" alt="Tessera Logo" width="400">

**USDC support engine for self-hosted platforms**

*Per-second and one-off support on [Circle x402](https://www.circle.com/nanopayments) and [Arc](https://www.arc.network)*

[![Build Passing](https://img.shields.io/badge/build-passing-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/JaDi03/tessera/actions)
[![Version](https://img.shields.io/github/package-json/v/JaDi03/tessera?style=for-the-badge)](https://github.com/JaDi03/tessera/releases)
[![License](https://img.shields.io/badge/license-Apache_2.0-yellow?style=for-the-badge)](https://github.com/JaDi03/tessera/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Circle x402](https://img.shields.io/badge/Circle_x402-2B3139?style=for-the-badge&logo=web3dotjs&logoColor=white)](https://developers.circle.com/gateway/nanopayments)
[![Arc Testnet](https://img.shields.io/badge/Arc_Testnet-5042002-6C63FF?style=for-the-badge)](https://docs.arc.network)

</div>

---

## TL;DR

Tessera sits next to your self-hosted platform so audiences can support creators and instance hosts in USDC: an optional tip on free content, or per-second support on exclusives.

The sidecar does not replace your app. A platform plugin loads the Tessera overlay and tells the sidecar when someone starts, stops, or tips. You install that plugin on the platform; you do not fork Tessera.

---

## The Problem

Self-hosted platforms give communities ownership, but they leave a gap: **there is no native way for audiences to support the infrastructure and creators they value.**

| Stakeholder | Pain Point |
|---|---|
| **Instance Administrators** | Bear 100% of infrastructure costs (servers, storage, bandwidth) with few tools beyond donations or ads |
| **Creators** | Publish on platforms they do not control, with no built-in path to direct support from their audience |
| **Viewers / Readers** | Want to support people they follow, but platform-wide subscriptions do not match what they actually consume |

Instances shut down when admins can no longer afford them. Creators move to commercial platforms. Communities fragment.

---

## The Solution

Tessera is a **USDC support engine**: a sidecar next to your platform, plus a plugin that loads the overlay. Free items stay open (`tessera:free`) with a manual tip. Exclusive items ask for a USDC deposit, then bill by the second while the viewer stays.

```mermaid
flowchart LR
    subgraph Client
        V((Viewer / Fan))
    end

    subgraph Server
        T{Tessera Sidecar}
        P[Self-Hosted Platform]
    end

    subgraph Financial Layer
        C[Circle x402 Gateway]
        W((Creator's Wallet))
    end

    V -- "1. Consumes Content" --> P
    P -- "2. Plugin events" --> T
    V -. "3. Tip or per-second support" .-> T
    T -- "4. Batches and settles" --> C
    C -- "5. USDC to creator" --> W

    style T fill:#ffb300,stroke:#333,stroke-width:2px,color:#000
    style W fill:#6C63FF,stroke:#fff,stroke-width:2px,color:#fff
```

**How support works:**

- **Free content** (`tessera:free`): no lock, no billing. Tip is manual only
- **Exclusive content**: viewer deposits USDC, then per-second support while they stay. Leave and replay do not freeze the player
- **Gas-free ticks**: the sidecar authorizes a nanopayment each second; settlement is batched
- **Cross-chain funding**: viewers can fund via Circle CCTP; settlement is on Arc Testnet

---

## How It Works

```mermaid
sequenceDiagram
    actor Viewer
    participant Paywall as paywall.js
    participant Plugin as PlatformPlugin
    participant Sidecar as TesseraSidecar
    participant Circle as CircleUCW_Gateway

    Viewer->>Paywall: opens content
    Paywall->>Circle: email or social plus SCA
    Paywall->>Sidecar: POST /api/core/circle/prepare-deposit
    Circle-->>Paywall: USDC deposit challenge
    Paywall->>Sidecar: POST /api/core/sync-session or register-session
    Plugin->>Sidecar: HMAC POST /api/core/v1/sessions/start
    loop Every second while connected
        Sidecar->>Circle: Gateway pay to creator
    end
    Plugin->>Sidecar: HMAC POST /api/core/v1/sessions/stop
    Note over Sidecar: Funds stay in Gateway
    Viewer->>Paywall: optional cash-out
    Paywall->>Sidecar: POST /api/core/cash-out
```

**In plain terms:**

1. **Viewer opens content** → The platform plugin loads the Tessera overlay (`paywall.js`).
2. **Viewer funds support** → Circle UCW (email OTP or social) creates an SCA on Arc Testnet. Exclusive content uses `POST /api/core/circle/prepare-deposit` (USDC) and a Circle challenge.
3. **Session key** → The overlay calls `POST /api/core/sync-session` (returning viewer) or `POST /api/core/register-session` (new key). Both prove Circle wallet ownership. Register may also deposit leftover SCA USDC into Gateway.
4. **Support ticks off-chain** → The plugin sends HMAC-signed `POST /api/core/v1/sessions/start`. Each second Tessera authorizes a nanopayment to the creator `payoutAddress`. `POST /api/core/v1/sessions/stop` (also HMAC) ends billing.
5. **Viewer leaves** → Funds stay in Gateway. A manual `POST /api/core/cash-out` returns unused USDC to the viewer's SCA. Tips use `POST /api/core/v1/tips` with Circle proof.

HMAC header details and the connector contract: [Connector spec](connectors/spec.md).

---

## Integrated Platforms

Tessera is live on PeerTube, Jellyfin, and Piwigo. Plugin install lives in each repo: [Integrated Platforms](platforms/index.md).

---

## Tech Stack

| Technology | Purpose | Why It Matters |
|---|---|---|
| [**Circle x402 Gateway**](https://developers.circle.com/gateway/nanopayments) | Batched settlement | USDC support as small as $0.000001 using HTTP 402 |
| [**Circle UCW SDK**](https://developers.circle.com/wallets/user-controlled) | Smart Contract Accounts on Arc Testnet | Non-custodial wallets with email OTP or social login |
| [**Circle CCTP Forwarding**](https://www.circle.com/cross-chain-transfer-protocol) | Cross-chain USDC bridging (Domain 26) | Viewers can fund USDC from a supported source chain |
| [**Arc Testnet**](https://docs.arc.network) | Settlement layer (Chain ID 5042002) | Native USDC gas, sub-second finality |
| [**EIP-3009**](https://eips.ethereum.org/EIPS/eip-3009) | Off-chain transfer authorization | Gasless signatures for per-second ticks |
| [**viem**](https://viem.sh/) | Type-safe EVM interactions | TypeScript library for chain calls |
| [**Express**](https://expressjs.com/) | Web application server | Node.js HTTP for the sidecar |

---

## Architecture Summary

Tessera uses a **sidecar pattern**. Two layers in this repo:

**Core Engine** (`src/core/`) - Session management, per-second billing, wallet ops, Circle Gateway / x402.

**Client Overlay** (`src/ui/`) - Overlay UI. Platforms load it from `/assets/`.

Platform plugins live outside this repo and call the HTTP contract.

Diagrams, fees, and settlement: [docs/ARCHITECTURE.md](ARCHITECTURE.md).

---

## What This Enables

- **Creators** get direct support (tips on free items, per-second on exclusives). Earnings accumulate in Gateway, then the creator withdraws to their wallet
- **Admins** can take a configurable share on time-based content to help cover hosting
- **Viewers** tip only if they want on free content, and pay only for the seconds they watch on exclusives. No platform-wide subscription

---

## License

Apache-2.0 - see [LICENSE](https://github.com/JaDi03/tessera/blob/main/LICENSE) for details.
