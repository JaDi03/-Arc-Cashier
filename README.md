<div align="center">
  <img src="docs/assets/logo_yellow.svg" alt="Tessera Logo" width="400">
  <br><br>

  <strong>USDC support engine for self-hosted platforms</strong>
  <br><br>

  <!-- Row 1: Status Badges -->
  <a href="https://github.com/JaDi03/tessera/actions"><img src="https://img.shields.io/badge/build-passing-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white" alt="Build Status"></a>
  <a href="https://github.com/JaDi03/tessera/releases"><img src="https://img.shields.io/badge/version-1.0.0-blue?style=for-the-badge" alt="Version"></a>
  <a href="https://github.com/JaDi03/tessera/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-yellow?style=for-the-badge" alt="License"></a>
  <br>
  <!-- Row 2: Tech Stack Badges -->
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://developers.circle.com/gateway/nanopayments"><img src="https://img.shields.io/badge/Circle_x402-2B3139?style=for-the-badge&logo=web3dotjs&logoColor=white" alt="Circle x402"></a>
  <a href="https://docs.arc.network"><img src="https://img.shields.io/badge/Arc_Testnet-6C63FF?style=for-the-badge" alt="Arc Testnet"></a>
  <br><br>

  <a href="https://jadi03.github.io/tessera/">Documentation</a>
  ·
  <a href="https://try-tessera.xyz">Live Playground</a>
</div>

---

## What is Tessera?

Tessera is a support engine, not a platform. If your app emits events a connector can read, admins and creators receive USDC from their audience. People stay where they already are.

- **Free content stays free**: optional tip.
- **Exclusive content** (tutorial, course, masterclass): support **by the second watched**. Ten minutes watched means ten minutes of support.

## Connect any platform

Tessera runs as a sidecar. Your stack keeps its UI; a plugin or webhook maps native events to Tessera over HTTP.

| Surface | Examples |
|---|---|
| Video / live | PeerTube (connector live), Jellyfin, Owncast |
| Audio / podcast | Navidrome, Funkwhale, Castopod |
| Photos | Immich, PhotoPrism |
| Posts / publishing | Ghost, WriteFreely |

New platform: implement the [integration contract](CONNECTOR_SPEC.md). No fork of Tessera.

---

https://github.com/user-attachments/assets/a85f14af-b1aa-4657-8f52-83f9ebd1c297

---

## How support works

### Tips on free content

The resource stays open. Tessera offers an optional USDC tip.

![Optional tip on free content](docs/assets/support-tip.png)

*Tips go to the creator.*

### Time-based support on exclusive content

The audience supports while watching and can leave anytime.

When the creator and the instance admin are not the same person, the default split is about **~90% creator / ~10% instance** (configurable; helps cover hosting).

![Time-based support on exclusive content](docs/assets/support-time.png)

---

## Why Arc

On traditional rails, a small tip dies in fees. On **Arc**, gas is USDC and network costs are on the order of cents. With Circle Gateway, support runs **off-chain** while people consume, so you are not paying a network fee for every tip or every second.

More detail: [Documentation](https://jadi03.github.io/tessera/) · [ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Quick start

**Run Tessera** (instance operator):

```bash
git clone https://github.com/JaDi03/tessera.git
cd tessera
npm install
cp .env.example .env
# Fill CIRCLE_*, MASTER_KEY, TESSERA_INGEST_SECRET
npm run build
npm start
```

**Build a connector** (platform developer): your plugin needs Tessera’s **Base URL** and the same **ingest secret** as `.env`. See [Getting started §3](docs/getting-started/index.md#3-tessera-base-url) and the [integration contract](CONNECTOR_SPEC.md).

Install, env, and deploy: [Getting started](https://jadi03.github.io/tessera/getting-started/).

---

## License

Apache-2.0 - see [LICENSE](LICENSE) for details.
