import express from 'express';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sessionService } from '../../core/session';
import { creatorService } from './creators';
import { isValidEvmAddress } from './gateway-creator';

const router = express.Router();

// NOTE - In-memory nonce tracking is sufficient for single-instance setups (representing the majority of deployments).
// If scaling to a distributed, multi-container architecture behind a load balancer, this usedNonces map should be migrated
// to a shared, high-speed cache with expiration (e.g., Redis with a TTL of 60 seconds) to prevent cross-instance replay attacks.
// We keep it in-memory for now to maintain zero-dependency setup and ease of installation.
const usedNonces = new Map<string, number>();

// Cleanup expired nonces in the background (every 1 minute)
setInterval(() => {
    const now = Date.now();
    for (const [key, t] of usedNonces.entries()) {
        if (now - t > 60000) usedNonces.delete(key);
    }
}, 60000);

/**
 * Validates the HMAC SHA-256 signature from PeerTube
 * Requires access to req.rawBody which must be populated by a middleware earlier in the chain.
 */
function verifySignature(signature: string | undefined, payload: Buffer | undefined): boolean {
    const secret = process.env.PEERTUBE_WEBHOOK_SECRET;
    
    if (!secret) {
        console.warn('[PeerTube] ⚠️ PEERTUBE_WEBHOOK_SECRET is not configured. Rejecting request.');
        return false;
    }

    if (!signature || !payload) {
        return false;
    }

    try {
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');

        // Prevent timing attacks
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    } catch (err) {
        console.error('[PeerTube] ❌ Error verifying signature:', err);
        return false;
    }
}

/**
 * Webhook endpoint for PeerTube
 * Expects the PeerTube plugin to send 'viewer_joined' and 'viewer_left' events.
 */
router.post('/webhook', async (req, res) => {
    // 1. Verify Signature
    const signature = req.headers['x-peertube-signature'] as string;
    // Note: We cast to any because rawBody is a custom property we will add in server.ts
    const rawBody = (req as any).rawBody; 

    if (!verifySignature(signature, rawBody)) {
        console.warn(`[PeerTube] 🔒 Invalid webhook signature from IP: ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }

    // 2. Parse payload safely since we already verified the rawBody
    let payload: any;
    try {
        payload = JSON.parse(rawBody.toString('utf-8'));
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const {
        event,
        userId,
        videoId,
        instanceUrl,
        ratePerSecond,
        timestamp,
        nonce,
        creatorAddress,
        creatorWallet,
        tesseraMode,
        adminWallet,
        displayFee,
        originFee,
        originInstanceUrl,
        isLocal
    } = payload;
    
    const resolvedCreatorAddress = (creatorAddress || creatorWallet || '').trim();

    console.log(`[PeerTube-Webhook-DEBUG] Event: ${event}, userId: ${userId}, videoId: ${videoId}, resolvedCreatorAddress: ${resolvedCreatorAddress}`);

    if (!event || !userId) {
        return res.status(400).json({ error: 'Missing required fields: event, userId' });
    }

    const now = Date.now();
    // Validate timestamp to prevent replay attacks (within 60 seconds)
    if (!timestamp || now - timestamp > 60000) {
        console.warn(`[PeerTube] ⚠️ Invalid or expired timestamp: ${timestamp}`);
        return res.status(401).json({ error: 'Unauthorized: Expired or missing timestamp' });
    }

    if (!nonce || usedNonces.has(nonce)) {
        return res.status(401).json({ error: 'Unauthorized: Missing or duplicated nonce' });
    }
    usedNonces.set(nonce, now);

    // 3. Dynamically persist local instance settings received from the plugin
    if (adminWallet && isValidEvmAddress(adminWallet)) {
        try {
            const DATA_DIR = path.resolve(process.cwd(), 'data');
            const SETTINGS_PATH = path.join(DATA_DIR, 'instance-settings.json');
            const settings = {
                adminWallet: adminWallet.trim(),
                displayFee: displayFee !== undefined ? Number(displayFee) : 0.10,
                originFee: originFee !== undefined ? Number(originFee) : 0.10
            };
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
            console.log(`[PeerTube-Webhook] 💾 Updated local instance settings: admin: ${settings.adminWallet} | displayFee: ${settings.displayFee} | originFee: ${settings.originFee}`);
        } catch (err) {
            console.error('[PeerTube-Webhook] ⚠️ Failed to save instance-settings.json:', err);
        }
    }

    // Determine the dynamic rate
    const MIN_RATE = 0.000001;
    const MAX_RATE = 0.01;
    let activeRate = 0.0001; // default fallback
    
    if (tesseraMode === 'free') {
        activeRate = 0;
    } else if (ratePerSecond !== undefined && !isNaN(Number(ratePerSecond))) {
        const rate = Number(ratePerSecond);
        if (rate === 0) {
            activeRate = 0;
        } else if (rate >= MIN_RATE && rate <= MAX_RATE) {
            activeRate = rate;
        } else {
            console.warn(`[PeerTube] ⚠️ Rate ${rate} out of bounds, using default`);
        }
    } else if (instanceUrl && videoId) {
        // Best effort: Log the metadata for future expansion
        console.log(`[PeerTube] ℹ️ Video ${videoId} from ${instanceUrl} joined without explicit rate. Using default $0.0001/s.`);
    }

    let payoutAddress: string | undefined;
    if (resolvedCreatorAddress && isValidEvmAddress(resolvedCreatorAddress)) {
        const validAddress = resolvedCreatorAddress;
        payoutAddress = validAddress;
        const existing = creatorService.getCreatorByAddress(validAddress);
        if (!existing) {
            const creatorId = videoId ? `peertube:${videoId}` : `wallet:${validAddress.toLowerCase()}`;
            creatorService.registerCreator(creatorId, validAddress, 0.10);
            console.log(`[PeerTube] 🧑‍🎨 Registered creator payout address ${validAddress}`);
        }
    } else if (resolvedCreatorAddress) {
        console.warn(`[PeerTube] ⚠️ Invalid creator wallet in webhook: ${resolvedCreatorAddress}`);
    }

    // 4. Process Events
    if (event === 'viewer_joined') {
        // If the video is free, do not start the per-second billing loop in the backend
        if (activeRate === 0) {
            console.log(`[PeerTube] ℹ️ Free video (tesseraMode=free / rate=0) for user ${userId}. Skipping billing loop.`);
            return res.json({ status: 'ok' });
        }

        // Determine local admin wallet and fees (with fallback to environment)
        const localAdminAddress = adminWallet || process.env.TESSERA_ADMIN_WALLET || process.env.SELLER_ADDRESS || undefined;
        const localDisplayFee = displayFee !== undefined ? Number(displayFee) : Number(process.env.TESSERA_DISPLAY_FEE || 0.10);

        let displayAdminAddress = localAdminAddress;
        let finalDisplayFee = localDisplayFee;
        let originAdminAddress: string | undefined = undefined;
        let finalOriginFee = 0;

        // Federation discovery (Phase 3b): query the remote PeerTube's public plugin API
        // to get the installed plugin version, then fetch instance-info through the plugin router.
        // This avoids direct sidecar access (hostname:7878) which fails behind reverse proxies.
        //
        // Step 1: GET {originInstanceUrl}/api/v1/plugins/peertube-plugin-tessera → { plugin: { version } }
        // Step 2: GET {originInstanceUrl}/plugins/peertube-plugin-tessera/{version}/router/instance-info
        //         → { adminWallet, originFee }
        //
        // Fails gracefully: if either request fails or times out, originFee = 0 and the
        // creator receives 100% of the federated session ticks.
        if (isLocal === false && originInstanceUrl) {
            console.log(`[PeerTube-Webhook] 🌐 Federated play detected from: ${originInstanceUrl}. Looking up remote Tessera plugin...`);
            try {
                // Step 1: Resolve plugin version from remote PeerTube's public REST API
                const pluginInfoRes = await fetch(
                    `${originInstanceUrl}/api/v1/plugins/peertube-plugin-tessera`,
                    { signal: AbortSignal.timeout(3000) }
                );

                if (pluginInfoRes.ok) {
                    const pluginInfo = await pluginInfoRes.json() as { plugin?: { version?: string }, version?: string };
                    const version = pluginInfo?.plugin?.version ?? pluginInfo?.version;

                    if (version) {
                        // Step 2: Fetch instance-info through the plugin relay (no port 7878 needed)
                        const instanceInfoUrl = `${originInstanceUrl}/plugins/peertube-plugin-tessera/${version}/router/instance-info`;
                        console.log(`[PeerTube-Webhook] 🔍 Fetching remote instance-info from: ${instanceInfoUrl}`);

                        const infoRes = await fetch(instanceInfoUrl, { signal: AbortSignal.timeout(3000) });

                        if (infoRes.ok) {
                            const remoteData = await infoRes.json() as { adminWallet?: string; originFee?: number };
                            if (remoteData.adminWallet && isValidEvmAddress(remoteData.adminWallet)) {
                                originAdminAddress = remoteData.adminWallet.trim();
                                finalOriginFee = remoteData.originFee !== undefined ? Number(remoteData.originFee) : 0.10;
                                console.log(`[PeerTube-Webhook] ✅ Federated origin: wallet ${originAdminAddress} | originFee ${finalOriginFee}`);
                            } else {
                                console.warn(`[PeerTube-Webhook] ⚠️ Remote instance-info missing valid adminWallet.`);
                            }
                        } else {
                            console.warn(`[PeerTube-Webhook] ⚠️ instance-info returned HTTP ${infoRes.status} from ${originInstanceUrl}`);
                        }
                    } else {
                        console.warn(`[PeerTube-Webhook] ⚠️ Could not determine Tessera plugin version on ${originInstanceUrl}`);
                    }
                } else {
                    // Remote server doesn't have Tessera installed or plugin API is inaccessible
                    console.log(`[PeerTube-Webhook] ℹ️ Remote server ${originInstanceUrl} has no Tessera plugin (HTTP ${pluginInfoRes.status}). Origin fees skipped.`);
                }
            } catch (err: any) {
                // Network timeout or unreachable — degrade gracefully
                console.warn(`[PeerTube-Webhook] ⚠️ Federation lookup failed for ${originInstanceUrl}: ${err.message}`);
            }
        }


        console.log(`[PeerTube-Webhook] 📊 Starting session for user: ${userId}. Payouts: creator ${payoutAddress}, displayAdmin: ${displayAdminAddress} (${finalDisplayFee}), originAdmin: ${originAdminAddress} (${finalOriginFee})`);
        
        sessionService.recordJoin(
            userId,
            videoId,
            activeRate,
            payoutAddress,
            displayAdminAddress,
            finalDisplayFee,
            originAdminAddress,
            finalOriginFee
        );
    } else if (event === 'viewer_left') {
        sessionService.recordPartAndSettle(userId).catch(console.error);
    } else {
        console.warn(`[PeerTube] ⚠️ Unknown event received: ${event}`);
    }
    // Always return 200 OK to acknowledge receipt
    res.json({ status: 'ok' });
});

export default router;
