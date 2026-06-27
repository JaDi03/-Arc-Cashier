# Prerequisites

Before you install Tessera, you need to ensure your environment is ready. Tessera is designed to be lightweight, but it relies on modern infrastructure and the Circle x402 Gateway.

## System Requirements

- **Node.js**: Version **22 or higher** is required. We recommend using [NVM (Node Version Manager)](https://github.com/nvm-sh/nvm) to install and manage Node.js versions.
- **Git**: Required to clone the repository.
- **Operating System**: Linux, macOS, or Windows (via WSL2).

## External Services

### 1. Circle Developer Account

Tessera leverages Circle's Programmable Wallets to handle the underlying blockchain transactions securely. You need a Circle Developer account to authenticate your sidecar.

To set up your account and obtain the necessary credentials, please follow our step-by-step visual guides:
- [How to get your Circle API Key](../tutorials/circle-api-key.md)
- [How to get your Circle App ID](../tutorials/circle-app-id.md)

You will need both of these keys during the configuration phase.

### 2. A Destination Wallet

You need a standard EVM-compatible wallet address (e.g., MetaMask, Rainbow, or a hardware wallet) to receive the settlement payouts from Tessera. This is the address where your USDC earnings will be sent when a session concludes.

### 3. A Supported Platform

Tessera is a sidecar, meaning it runs *alongside* another platform. You should have one of the following running and accessible:
- An **Owncast** instance.
- A **PeerTube** instance (with the Tessera plugin installed).
- Any custom platform capable of emitting webhook events.

---

Once you have your Node environment ready and your Circle credentials at hand, you can proceed to the [Installation guide](installation.md).
