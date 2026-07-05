import express from 'express';
import crypto from 'crypto';
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
router.post('/webhook', (req, res) => {
    // 1. Verify Signature
    const signature = req.headers['x-peertube-signature'] as string;
    // Note: We cast to any because rawBody is a custom property we will add in server.ts
    const rawBody = (req as any).rawBody; 

    if (!verifySignature(signature, rawBody)) {
        console.warn(`[PeerTube] 🔒 Invalid webhook signature from IP: ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }

    // 2. Parse payload safely since we already verified the rawBody
    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf-8'));
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const { event, userId, videoId, instanceUrl, ratePerSecond, timestamp, nonce, creatorAddress, creatorWallet } = payload;
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

    // Determine the dynamic rate
    const MIN_RATE = 0.000001;
    const MAX_RATE = 0.01;
    let activeRate = 0.0001; // default fallback
    
    if (ratePerSecond !== undefined && !isNaN(Number(ratePerSecond))) {
        const rate = Number(ratePerSecond);
        if (rate >= MIN_RATE && rate <= MAX_RATE) {
            activeRate = rate;
        } else {
            console.warn(`[PeerTube] ⚠️ Rate ${rate} out of bounds, using default`);
        }
    } else if (instanceUrl && videoId) {
        // Best effort: Log the metadata for future expansion (e.g., fetching custom pricing from API)
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

    // 3. Process Events (Following building-a-connector.md)
    if (event === 'viewer_joined') {
        // --- Deterministic Platform Fee Split (PeerTube-specific) ---
        // PeerTube has a distinct admin (instance host) and content creator.
        // Both addresses and the fee percentage are passed to the session service,
        // which applies the split deterministically: every Nth payment tick goes to
        // the admin (where N = round(1 / platformFee)), and the rest go to the creator.
        // This guarantees an exact proportional split on EVERY session, unlike the
        // previous per-session dice roll which could give 100% to one party unfairly.
        const platformFee = payoutAddress
            ? (creatorService.getCreatorByAddress(payoutAddress)?.platformFee ?? 0.10)
            : 0;
        const platformAdminAddress = process.env.SELLER_ADDRESS || undefined;

        console.log(`[PeerTube] 📊 Session fee split: ${((1 - platformFee) * 100).toFixed(0)}% creator / ${(platformFee * 100).toFixed(0)}% admin (every ${Math.round(1 / (platformFee || 1))} ticks)`);
        console.log(`[PeerTube-Webhook-DEBUG] Recording join for user: ${userId}. Payout creator: ${payoutAddress}, Admin: ${platformAdminAddress}, platformFee: ${platformFee}`);

        sessionService.recordJoin(userId, videoId, activeRate, payoutAddress, platformAdminAddress, platformFee);
    } else if (event === 'viewer_left') {
        sessionService.recordPartAndSettle(userId).catch(console.error);
    } else {
        console.warn(`[PeerTube] ⚠️ Unknown event received: ${event}`);
    }

    // Always return 200 OK to acknowledge receipt
    res.json({ status: 'ok' });
});

export default router;
