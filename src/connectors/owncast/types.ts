// Owncast types based on services/webhooks/webhooks.go

export interface OwncastUser {
    id: string;
    displayName: string;
    displayColor?: number;
    createdAt?: string;
    previousNames?: string[];
}

export type BaseWebhookData = Record<string, unknown>;

export interface WebhookUserJoinedEventData extends BaseWebhookData {
    id: string;
    timestamp: string; // ISO 8601
    user: OwncastUser;
}

export interface WebhookUserPartEventData extends BaseWebhookData {
    id: string;
    timestamp: string; // ISO 8601
    user: OwncastUser;
}

// Standard payload sent by Owncast to the webhook server
export interface OwncastWebhookPayload {
    type: string; // e.g., 'USER_JOINED' | 'USER_PARTED' | 'CHAT'
    eventData: WebhookUserJoinedEventData | WebhookUserPartEventData | Record<string, unknown>;
}
