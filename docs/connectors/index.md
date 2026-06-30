# What is a Connector?

A **connector** (also known as a *sidecar*, *middleware*, or *plugin*) is an external process or lightweight adapter that "attaches" to the surface of an existing application to listen to the events it naturally emits.

Its main function is to act as a **translator**: it takes a stream of data (which the original application generates for its own purposes) and converts it into actionable events for a secondary system (like a payments or metrics engine).

The primary advantage of this model is that it allows adding new capabilities (such as pay-per-use monetization or tipping) to any open-source software **without needing to modify its source code, maintain forks, or wait for the original developers to implement the feature**.

---

## What types of events can a connector intercept?

A connector can leverage different "surfaces" or data structures depending on the nature of the underlying system. The main interceptable events include:

### 1. Presence Events (Live Streaming / VOD)
Through *webhooks* or *WebSockets* connections, the connector intercepts the exact moment a viewer joins a stream and the exact moment they leave. This allows measuring and acting upon real-time presence.

### 2. Media Consumption Events (Music / Audio)
By reading local databases or intercepting the streaming protocol, the connector captures "scrobble" events (playback logs), detecting every time a user listens to a track entirely or partially.

### 3. Asset Resolution Events (Photography / Files)
Acting as a router or reading *access logs*, the connector detects whenever a third party resolves (opens) a public or shared link of a media asset, identifying the original creator of that asset.

### 4. Citation or Syndication Events (Feeds / Text)
Acting as *middleware*, the connector captures when an aggregator or crawler (like Artificial Intelligence engines) consumes an article's URL, allowing it to register the provenance and authorship of the extracted text.

### 5. Federated Activity Events (Social Networks)
By intercepting the activity stream, the connector reads interactions such as replies, boosts, or financial support intents emitted by nodes in a decentralized social network.
