# Payment Models

Tessera supports two distinct payment mechanisms natively within the same sidecar infrastructure. Both operate entirely off-chain until the session ends.

---

## 1. Per-Second Streaming (Time-based)

This is the default mode for continuous content like live streams, music, or video playback. 

As long as the viewer's connection is active, the Tessera client silently generates an EIP-3009 cryptographic signature every second. The billing engine accumulates these signatures off-chain, verifying that the user has enough balance. The viewer is strictly charged for the exact time consumed.

*(You can place a screenshot of the streaming UI here)*

---

## 2. Direct Tipping (Event-based)

Viewers can send one-off, voluntary contributions directly to the creator. 

When a viewer clicks the "Tip" button, a single, larger authorization signature is generated. This can occur simultaneously alongside an active per-second streaming session. Tips are aggregated into the same off-chain balance and settled together with the streaming costs when the session concludes.

*(You can place a screenshot of the tipping modal here)*
