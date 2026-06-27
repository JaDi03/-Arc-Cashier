# Architecture & Fees

## Production & Architecture (V1)

Tessera V1 is designed to be a robust, developer-friendly MVP. To ensure stability and ease of deployment, the following architectural decisions and limitations are present in this version:

### Architecture: Universal Deposits (CCTP) & Arc Settlement

While Tessera requires the **Arc Network** to operate its core billing engine, **viewers can fund their sessions from any supported network** (Ethereum, Polygon, Base, etc.) thanks to **Circle's CCTP** (Cross-Chain Transfer Protocol).

```mermaid
flowchart LR
    %% Custom Premium Styling
    classDef origin fill:#1A1B26,stroke:#7AA2F7,stroke-width:2px,color:#FFFFFF,rx:10,ry:10
    classDef cctp fill:#1F2335,stroke:#9ECE6A,stroke-width:2px,color:#FFFFFF,rx:10,ry:10
    classDef arc fill:#24283B,stroke:#BB9AF7,stroke-width:3px,color:#FFFFFF,rx:10,ry:10,stroke-dasharray: 5 5
    classDef blockchain fill:#24283B,stroke:#F7768E,stroke-width:2px,color:#FFFFFF,rx:10,ry:10
    classDef engine fill:#1F2335,stroke:#7DCFFF,stroke-width:2px,color:#FFFFFF,rx:5,ry:5

    subgraph Origins ["🌐 Origin Networks"]
        direction TB
        ETH["Ethereum"]:::origin
        POL["Polygon"]:::origin
        BAS["Base"]:::origin
    end

    CCTP(("🔄 Circle CCTP")):::cctp
    
    subgraph ArcNet ["⚡ Arc Network"]
        direction TB
        Gateway["💎 Gateway Contract"]:::blockchain
        Engine["⚙️ Billing Engine"]:::engine
    end
    class ArcNet arc

    ETH -->|"USDC"| CCTP
    POL -->|"USDC"| CCTP
    BAS -->|"USDC"| CCTP
    
    CCTP --->|"Route & Fund"| Gateway
    Engine -.->|"Batched micro-claims"| Gateway
```

**Why must the settlement engine run exclusively on Arc?**

Tessera is designed for **high-frequency, per-second micro-billing**. Implementing this economic model on traditional EVM networks is economically unviable due to unpredictable gas fees. 

By leveraging the **Arc Network** combined with the **x402 protocol**:

- **Predictable, Ultra-Low Costs**: Arc is specifically designed for stablecoin-native applications, targeting an average transaction fee of **~$0.01 USDC**.
- **Gasless Streaming**: Once the session begins, viewers sign off-chain cryptographic proofs every second without paying any gas.
- **Batched Settlement**: The Circle Gateway aggregates thousands of these micro-signatures and settles the final balances efficiently on the Arc Network.
- **Economic Viability**: On traditional networks, watching a 10-minute stream could cost more in gas than the content itself. Arc's ~$0.01 fees make the math work, ensuring that network costs never consume the actual value of the stream.

### Environment Configuration
- **Dynamic Routing:** `PUBLIC_URL` is required in production to ensure the Gateway can map callbacks and references correctly, bypassing the hardcoded `localhost` limitations.
- **Gas Buffer:** `RETAINED_GAS_AMOUNT` (default 0.1 USDC) is utilized to ensure the ephemeral wallet always retains enough native token for on-chain interactions without failing.

### Security & Performance
- **Rate Limiting:** Critical endpoints (`/register-session` and `/end-session`) are protected by IP rate limiting to prevent spam and DDoS attempts.
- **Memory Optimization:** `GatewayClient` instances are cached in memory. Ephemeral keys and instances are strictly wiped using a safe sweep upon session termination.
- **Dynamic Top-Up:** Viewers are alerted dynamically when their balance drops below 5 minutes of viewing time, allowing them to top-up without interrupting the video stream.

### Observability
- **Healthcheck:** A robust endpoint at `GET /health` provides real-time status of active sessions and connectivity to the Circle Gateway, suitable for integration with Prometheus or UptimeKuma.

### V1 Limitations & Trade-offs
- **Polling over Webhooks:** To maximize developer experience (DX) and allow seamless testing on `localhost` without tunnels (like ngrok), V1 actively polls Circle for deposit confirmations instead of relying on Webhooks.
- **Fixed Payment Scheme:** The protocol currently forces the `GatewayWalletBatched` scheme on Arc Testnet. While x402 supports dynamic schemes like `CompositeEvmScheme`, they are disabled in V1 to maintain strict focus on streaming micro-payments.
