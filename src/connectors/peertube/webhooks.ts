import express from 'express';
import crypto from 'crypto';
import { sessionService } from '../../core/session';

const router = express.Router();

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

    const { event, userId } = payload;

    if (!event || !userId) {
        return res.status(400).json({ error: 'Missing required fields: event, userId' });
    }

    // 3. Process Events (Following BUILDING_A_CONNECTOR.md)
    if (event === 'viewer_joined') {
        sessionService.recordJoin(userId);
    } else if (event === 'viewer_left') {
        sessionService.recordPartAndSettle(userId).catch(console.error);
    } else {
        console.warn(`[PeerTube] ⚠️ Unknown event received: ${event}`);
    }

    // Always return 200 OK to acknowledge receipt
    res.json({ status: 'ok' });
});

export default router;
