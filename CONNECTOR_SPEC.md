# Tessera connector spec

This document is for whoever writes a **plugin, webhook, or native service** on a platform.

Read native events, translate them, and call `start`, `stop`, or `tips`. Load Tessera UI in the browser for viewer wallets and paywalls.

**Also read:** [Getting started §3 (Base URL)](docs/getting-started/index.md#3-tessera-base-url) · [Viewer wallet](docs/tutorials/viewer-wallet.md) · [PeerTube plugin (reference)](https://github.com/JaDi03/peertube-plugin-tessera)

## Which of the three to call

- **Time** (video, live, a track or podcast while it plays): `sessions/start` then `sessions/stop`.
- **A gesture** (photo, post, boost, citation, download, "support this"): `tips`.

Do **not** call `start` for tip-only resources. Use `initTipMode` in the browser and `tips` when the viewer taps support.

## 1. What the plugin must have

### Reach Tessera

- **Tessera Base URL**: origin the **platform server** uses to POST. How to pick it: [Getting started §3](docs/getting-started/index.md#3-tessera-base-url). Confirm with `GET {Base URL}/health`.
- **Ingest secret**: same value as `TESSERA_INGEST_SECRET` on Tessera ([`.env.example`](.env.example)). Used only for HMAC on `start` and `stop`.

Paths below are relative to `{Base URL}/api/core`. `CIRCLE_*` keys stay in Tessera `.env`, not in the plugin.

**Base URL vs browser URL**

| | Used by | Example |
|---|---|---|
| **Base URL** | Plugin server (`start` / `stop` HMAC) | `http://127.0.0.1:7878` |
| **Browser / PUBLIC_URL** | Viewer loading `paywall.bundle.js` and paywall API calls | `https://tessera.example.com` or your plugin relay origin |

They are often the same origin in dev. In production the browser usually hits a **plugin relay** on the platform origin (see §2).

### Resolve before you POST

The plugin computes these before each POST:

| Field | Meaning |
|---|---|
| `userId` | Tessera viewer id (see **userId format** below). Same value on `start`, `stop`, and `tips`. |
| `resourceId` | `videoId`, `trackId`, `photoId`, `postId`, `streamId`, ... |
| `payoutAddress` | Creator (or primary payee) USDC address on Arc. |
| `ratePerSecond` | Decimal USDC string. **Required** on time-based `start`. Must be `>= 0`; use a value `> 0` for real billing. |
| `splits` | Optional array. Each entry: `{ address, fraction, label? }`. Sum of fractions `<= 1`. Remainder goes to `payoutAddress`. `label` is log-only. Time-based `start` only. |
| `amount` | Decimal USDC string (e.g. `"0.100000"`). `tips` only. |
| `metadata` | Optional. Opaque key/value strings for your connector logs. Tessera billing does not read it today. |

`tips` has no `splits`. One `payoutAddress` per tip.

### userId format (critical)

`userId` is **not** your platform's native account id. Tessera assigns it after the viewer signs in through the paywall (Circle email OTP or Google).

Valid formats (7-256 chars):

| Prefix | Example | When set |
|---|---|---|
| `email:` | `email:viewer@example.com` | Email OTP login |
| `social:` | `social:104083036205001006721` | Google / Facebook login |
| `arc_` | `arc_mlbogxpfyg` | Legacy sessions only |

Invalid: `user-42`, PeerTube account ids, Jellyfin user ids, random UUIDs without a valid prefix.

**Rule:** the browser paywall and your server must use the **same** `userId`.

1. Load `paywall.bundle.js` and call `initPaywall()` or `initTipMode()`.
2. Viewer completes Circle login in the paywall.
3. Paywall stores `userId` in `localStorage` under `arc_cashier_user_id`.
4. Your connector client reads that value and sends it on `start` / `stop` pings to your plugin server.
5. Your plugin server forwards the same `userId` in HMAC `start` / `stop` (and the browser sends it on `tips`).

If you POST `start` before the viewer has logged in, or with a platform-native id, `register-session` and `tips` will fail.

## 2. Browser UI and relay

### Embed the paywall

The bundle does **not** auto-init. Load it from Tessera or from your relay, then call the right init for the resource billing mode.

```html
<!-- Serve from Tessera PUBLIC_URL or from your plugin relay (see below) -->
<script src="https://tessera.example.com/assets/paywall.bundle.js"></script>
<script>
  // Exclusive / pay-per-second (locks media until funded)
  window.ArcCashier.initPaywall();

  // Free / tip-only (optional second argument: default tip amount in USDC, e.g. 0.10)
  // window.ArcCashier.initTipMode('0xCreatorAddress...', 0.10);

  // Creator earnings panel in your platform settings UI
  // window.ArcCashier.initCreatorEarnings({ wallet: '0xCreator...', mount: '#earnings' });
</script>
```

**Admin vs creator**

- Platform has an admin **and** creators: use both. Admin: settings page (§3). Creator: `initCreatorEarnings`.
- Platform is admin-only: use the admin one (§3).

**API base derivation:** paywall resolves `ARC_API_BASE` from the script URL by stripping `/assets/<bundle>`. Example:

- Script: `https://tessera.example.com/assets/paywall.bundle.js` → API `https://tessera.example.com`
- Script: `https://peertube.example.com/plugins/tessera/assets/paywall.bundle.js` → API `https://peertube.example.com/plugins/tessera`

If the bundle is served from the wrong path, all `/api/core/*` calls go to the wrong host.

**Assets**

| File | Required | Notes |
|---|---|---|
| `paywall.bundle.js` | Yes | You load this via `<script src>`. |
| `paywall.css` | Auto | Injected by `initPaywall`, `initTipMode`, and `initCreatorEarnings` from the same directory as the script. |
| `creator-earnings.css` | Auto | Injected by `initCreatorEarnings` from the same directory as the script. |

Viewer paywall, tip button, and creator earnings are Tessera UI. Plugins call `initPaywall` / `initTipMode` / `initCreatorEarnings`. They do not restyle `.arc-tessera-root`.

No other static files are required for the viewer paywall.

**`initPaywall(targetContainer)`** — optional `HTMLElement` or CSS selector. Accepted for API compatibility; the overlay currently mounts fullscreen on `document.body` (player-contained mounts break hit-testing on some hosts).

**`initTipMode(creatorWallet, tipAmount)`** — `creatorWallet` is a `0x` EVM address. `tipAmount` is a USDC number (default `0.10` if omitted). Tips are sent as decimal strings with up to 6 places.

### Plugin relay (recommended in production)

Tessera enables CORS on all routes, but production setups usually **proxy** Tessera through the platform so:

- The browser stays on the platform origin (cookies, OAuth redirects).
- Tessera can remain server-to-server only for ingest HMAC.

Proxy at minimum:

| Path | Purpose |
|---|---|
| `/assets/paywall.bundle.js` | Paywall script |
| `/assets/paywall.css` | Paywall styles (if not loaded via bundle injection path) |
| `/assets/creator-earnings.css` | Creator earnings styles (if not loaded via bundle injection path) |
| `/api/core/*` | Paywall wallet, session, tips, Circle auth |

The reference [PeerTube plugin](https://github.com/JaDi03/peertube-plugin-tessera) serves assets and relays API calls. Copy that pattern: expose a stable browser origin; keep **Base URL** as the server-to-server Tessera address for HMAC.

Tessera does **not** have to be on the public internet if the platform server and relay can reach it.

### Tips flow (browser)

`POST /v1/tips` is called from the **browser** (paywall tip button), not from your ingest HMAC server. Your server may also POST `tips` if you already have a funded Gateway session for that `userId`, but the usual path is:

1. Load `paywall.bundle.js`.
2. `initTipMode(creatorWallet, tipAmount)`.
3. Viewer signs in (email or Google) and funds wallet in the paywall UI.
4. Paywall calls `POST /api/core/register-session` (Gateway deposit). This requires a valid `userId` and Circle `userToken`.
5. Viewer clicks tip → paywall calls `POST /api/core/v1/tips` with `{ userId, payoutAddress, amount }`.
6. `402` = insufficient Gateway balance. `404` = no session for `userId` (viewer has not completed step 4).

Server-side `start` / `stop` do **not** fund the viewer wallet. Funding is always through the paywall.

## 3. Plugin settings dashboard

Ship an admin page on the platform (your plugin settings UI, webhook config page, or admin panel route). That config belongs to the plugin — not to Tessera `.env`.

**Required for any connector:**

| Setting | Maps to | Notes |
|---|---|---|
| Tessera Base URL | Server-to-server POST origin | Used for HMAC `start` / `stop`. Confirm: `GET {Base URL}/health`. |
| Tessera Ingest Secret | `TESSERA_INGEST_SECRET` | Copy from Tessera `.env.example`. Never expose to the browser. |

**For time-based billing — add only if your platform meters consumption over time (video, audio, live):**

| Setting | Maps to | Notes |
|---|---|---|
| Creator wallet | `payoutAddress` | Per-channel, per-artist, or per-resource. |
| Rate per second (USDC) | `ratePerSecond` on `start` | e.g. `0.000100`. |
| Platform fee wallet | `splits[].address` | Optional. Your platform's cut. |
| Platform fee fraction | `splits[].fraction` | e.g. `0.1` = 10%. Remainder → creator. |

**For tip-only billing — all platforms need this if they support tips:**

| Setting | Maps to | Notes |
|---|---|---|
| Creator wallet | `payoutAddress` in `tips` | Resolve from EXIF, feed author, post metadata — whatever your platform exposes. |
| Default tip amount (USDC) | `initTipMode(wallet, amount)` | Optional. Default `0.10` if omitted. |

If your platform is exclusively tip-based (photos, posts, RSS, newsletter, fediverse): you only need the Required fields and the tip-only section above.

## 4. Native events → Tessera

Map each native event to one of the three calls.

### `POST /v1/sessions/start`

Time started. HMAC required.

Typical native events: `userJoined`, PlaybackStart, Play, NowPlaying, exclusive VOD/live start, podcast/music **listen start while it is playing**.

```json
{
  "userId": "email:viewer@example.com",
  "resourceId": "content-abc",
  "ratePerSecond": "0.000100",
  "payoutAddress": "0x...",
  "splits": [
    { "address": "0x...", "fraction": 0.1, "label": "platform-fee" }
  ],
  "metadata": { "platform": "your-platform", "channelId": "3" }
}
```

- `ratePerSecond`: USDC decimal string. Must be `>= 0`. Values `> 0` bill per second. `"0"` is accepted but bills nothing; for tip-only content use `initTipMode` and `tips`, not `start`.
- `splits`: optional; sum of fractions `<= 1`.
- Billing is wall-clock from this call until `stop`. `stop` has no duration field.

Response: `{ "status": "session_started", "sessionId": "userId" }`

**Viewer funding:** `start` does not check the viewer's Gateway balance — the paywall does that before unlocking playback. If the viewer is not yet funded, `initPaywall()` will block media and prompt a deposit before your connector ever sends `start`.

**Session edge cases**

| Situation | What to do |
|---|---|
| Switch resource while charging | `stop` previous `userId`, then `start` with new `resourceId` / rate. |
| Second `start` same `userId` without `stop` | Overwrites the active session (new rate/resource). Prefer `stop` first. |
| Pause should stop billing | Send `stop`. Send `start` again on resume if you still charge. |
| Tab close / disconnect | Send `stop` on best-effort (`beforeunload`, websocket leave, idle timeout). |
| Viewer not logged in yet | Do not `start` until `arc_cashier_user_id` is available from the paywall client. |

### `POST /v1/sessions/stop`

Time ended. HMAC required.

Typical native events: `userParted`, PlaybackStopped, Stop, leave, pause (if charging should stop), listen end **if you already sent `start`**.

```json
{ "userId": "email:viewer@example.com" }
```

Response: `{ "status": "session_stopped" }`

### `POST /v1/tips`

One amount, now. **No ingest HMAC.** Requires a Gateway session for `userId` (see §2 tips flow).

Typical native events: tip button click (browser); or server gesture if session already funded.

```json
{
  "userId": "email:viewer@example.com",
  "payoutAddress": "0x...",
  "amount": "0.100000"
}
```

Response: `{ "status": "success", "amount", "payoutAddress" }`

PlaybackProgress, ping, and heartbeat: ignore for billing. The meter already runs after `start`. Resolve payee (wallet, EXIF artist, MBID) in the plugin, then POST.

### By surface

**Live / VOD (Owncast, Jellyfin, PeerTube)**

- Exclusive: play → `start`; leave/stop/pause → `stop`. UI: `initPaywall()`.
- Free: UI: `initTipMode()`. Tips from browser. Do not `start`.
- Progress webhooks: ignore.

**Music server (Navidrome, Subsonic, Airsonic, Ampache, ...)**

- Platform emits play/stop in real-time: `NowPlaying` / `play` → `start`; stop/pause → `stop`.
- Platform only emits a scrobble at track end (no live play event): use `tips` with the computed amount. Do not invent a `start` you cannot pair with a `stop`.
- `payoutAddress`: resolve from track metadata (MusicBrainz artist, Beets custom field). Do not use the platform's native account id.

**Music metadata tools (Beets, Maloja, Picard)**

These are not billing surfaces — they resolve identity and wallet addresses.

- Beets / Picard: query before POSTing `start` or `tips` to get `payoutAddress` and `splits` from artist/composer credits.
- Maloja: accepts scrobbles inbound → map to `tips` (same as scrobble-only music server above).
- Do not call `start` / `stop` from a tagging tool.

**Podcasting + audio (Audiobookshelf, Castopod, AntennaPod)**

- Support while it plays: play event → `start`; stop/pause → `stop`.
- Support this episode (one-time gesture): `tips` only.
- If the platform uses Podcasting 2.0 `<podcast:value>` tags or Castopod Premium: those are separate payment rails. Tessera is additive — do not replace them.

**Photos / galleries (Immich, PhotoPrism, Lychee, ...)**

Photos have no duration — there is nothing to meter. Never call `start` or `stop`.

- UI: `initTipMode(creatorWallet)`. The paywall renders a tip button next to the image.
- On tip gesture (download, like, support button): `POST /v1/tips` from the browser or your server.
- `payoutAddress`: resolve from EXIF metadata (photographer's wallet), not from the platform account system.
- `resourceId` is optional since there is no timed session; pass it via `metadata` if you need per-photo earnings in stats.

**Feeds + RSS (FreshRSS, Miniflux, Wallabag)**

Always `tips` only — reading an article is not a timed session.

- `resourceId`: use the canonical URL of the article (stable, unique per post).
- `payoutAddress`: resolve from the feed's `<author>` or a wallet tag in the feed.
- UI: inject `initTipMode` next to each item in the reader UI.

**Publishing + newsletter (Ghost, WriteFreely, Halo)**

Always `tips` only — a post or newsletter is not metered by the second.

- `initTipMode` in the post template or alongside a subscribe button.

**Fediverse (Mastodon, Lemmy, Pixelfed)**

- `tips` only. Do not meter reading a post by the second.
- Map a native tip, boost, or donation gesture to `POST /v1/tips`.
- Or inject `initTipMode` in the post or profile view.

## 5. HMAC (`start` and `stop` only)

Headers:

- `X-Tessera-Timestamp`: unix ms
- `X-Tessera-Nonce`: unique string (single use)
- `X-Tessera-Signature`: hex HMAC-SHA256 of `timestamp.nonce.rawBody` with the ingest secret

Replay window: 60 seconds. Duplicate nonce: 401.

```js
const crypto = require('crypto');

const secret = process.env.TESSERA_INGEST_SECRET;
const rawBody = JSON.stringify({
  userId: 'email:viewer@example.com',
  resourceId: 'content-abc',
  ratePerSecond: '0.000100',
  payoutAddress: '0x...',
});
const timestamp = Date.now().toString();
const nonce = crypto.randomUUID();
const signature = crypto
  .createHmac('sha256', secret)
  .update(`${timestamp}.${nonce}.${rawBody}`)
  .digest('hex');

await fetch(`${baseUrl}/api/core/v1/sessions/start`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Tessera-Timestamp': timestamp,
    'X-Tessera-Nonce': nonce,
    'X-Tessera-Signature': signature,
  },
  body: rawBody,
});
```

Sign the exact bytes you send as the body.

## 6. Creator earnings API

Embed creator balance and withdraw with `window.ArcCashier.initCreatorEarnings({ wallet, apiBase?, mount?, title? })`. Same Tessera chrome as the viewer widgets: the call injects `paywall.css` and `creator-earnings.css`.

- `wallet` (required): creator `0x` address.
- `apiBase` (optional): override API origin; defaults to script URL derivation.
- `mount` (optional): `HTMLElement` or selector; defaults to `document.body`.
- `title` (optional): panel heading.

HTTP routes (relative to `/api/core`):

### `GET /creator/balance?address=0x...`

Response:

```json
{
  "status": "success",
  "address": "0x...",
  "gatewayAvailable": "1.234567",
  "gatewayWithdrawable": "1.234567",
  "gatewayTotal": "1.234567"
}
```

### `POST /creator/prepare-withdraw`

Body: `{ "address": "0x..." }`

Response when ready: `{ "status": "ready", "amount", "burnIntent", "typedData" }`  
Response when balance too low: `{ "status": "no_funds", ... }`

### `POST /creator/complete-withdraw`

Body: `{ "address", "burnIntent", "signature" }` (EIP-712 from MetaMask)

Response: `{ "status": "ready_to_mint", "transferId", "txRequest" }`

### `GET /creator/stats?address=0x...`

Response:

```json
{
  "status": "success",
  "stats": [
    { "resourceId": "resource-abc", "amount": 0.05 },
    { "resourceId": "resource-xyz", "amount": 1.20 }
  ]
}
```

Each entry is a `resourceId` your connector sent on `start` (or via `tips`) that generated earnings for `address`. `amount` is in USDC. Tessera does not interpret the value — it is whatever your connector passed.

## 7. Errors

| HTTP | Endpoint | When |
|---|---|---|
| 400 | `start` | Missing `userId`, `resourceId`, `ratePerSecond`, or `payoutAddress`; invalid address or split fraction |
| 400 | `start` | `splits` fractions sum > 1 |
| 400 | `stop` | Missing `userId` |
| 401 | `start`, `stop` | Missing/invalid HMAC, expired timestamp (> 60 s), or duplicate nonce |
| 402 | `tips` | Insufficient Gateway balance |
| 404 | `tips` | No Gateway session for `userId` (viewer has not funded wallet) |
| 500 | `stop`, creator | Settlement failed or Tessera server error |

## 8. Verification checklist

Run in order when wiring a new connector:

1. `curl -sS {Base URL}/health` → `status: healthy`
2. HMAC `POST /api/core/v1/sessions/start` with a test `userId` / `resourceId` → `session_started`
3. HMAC `POST /api/core/v1/sessions/stop` → `session_stopped`
4. Browser loads `{origin}/assets/paywall.bundle.js` without 404
5. `initPaywall()` or `initTipMode()` → Circle login completes
6. `localStorage.getItem('arc_cashier_user_id')` returns `email:...` or `social:...`
7. Connector server uses that same `userId` on `start` / `stop`
8. Fund wallet in paywall → `register-session` succeeds
9. Tip button → `POST /v1/tips` → `success`
10. Creator panel → `GET /creator/balance` returns funds after sessions

Reference implementation: [peertube-plugin-tessera](https://github.com/JaDi03/peertube-plugin-tessera).
