import { Router, Request, Response } from 'express';
import { sessionService } from '../../core/session';
import type { OwncastWebhookPayload, WebhookUserJoinedEventData, WebhookUserPartEventData } from './types';

const owncastRouter = Router();

owncastRouter.post('/webhook', async (req: Request, res: Response) => {
    const payload = req.body as OwncastWebhookPayload;

    if (!payload || !payload.eventData || !payload.eventData.user) {
        return res.status(400).json({ error: "Invalid Owncast Webhook format" });
    }

    if (payload.type === 'USER_JOINED') {
        const eventData = payload.eventData as WebhookUserJoinedEventData;
        console.log(`[Owncast] 📥 Received USER_JOINED webhook for ${eventData.user.id}`);
        sessionService.recordJoin(eventData.user.id);
        return res.json({ status: "recorded" });
    } 
    else if (payload.type === 'USER_PARTED') {
        const eventData = payload.eventData as WebhookUserPartEventData;
        // Launch the promise but don't block the webhook response
        // Owncast needs to know we received the webhook quickly (fire & forget)
        sessionService.recordPartAndSettle(eventData.user.id).catch(console.error);
        return res.json({ status: "processing_settlement" });
    }

    return res.json({ status: "ignored_event_type" });
});

export default owncastRouter;
