/**
 * Native Chat Channel Adapter
 *
 * Handles real-time chat messages via Convex mutations (no external API).
 * Messages are stored directly in the database.
 */

import type { ChannelAdapter, OutboundMessage, SendResult, ParsedMessage, DeliveryStatus, ChannelHealth } from './types';

interface ChatInboundPayload {
	userId?: string;
	from?: string;
	text?: string;
	message?: string;
	html?: string;
	mediaUrl?: string;
	attachmentUrl?: string;
	messageId?: string;
	timestamp?: number;
	userName?: string;
	avatarUrl?: string;
	metadata?: Record<string, string>;
}

export class ChatAdapter implements ChannelAdapter {
	id = 'chat' as const;

	async send(_message: OutboundMessage): Promise<SendResult> {
		// Chat messages are stored directly via Convex mutations
		// The send() method here is a no-op since the caller handles persistence
		return {
			success: true,
			externalMessageId: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
		};
	}

	parseInbound(raw: unknown): ParsedMessage {
		const payload = raw as ChatInboundPayload;
		return {
			from: payload.userId ?? payload.from ?? '',
			content: {
				text: payload.text ?? payload.message ?? '',
				html: payload.html,
				mediaUrl: payload.mediaUrl ?? payload.attachmentUrl,
			},
			externalMessageId: payload.messageId ?? `chat_${Date.now()}`,
			timestamp: payload.timestamp ?? Date.now(),
			metadata: {
				userName: payload.userName,
				avatarUrl: payload.avatarUrl,
				...payload.metadata,
			},
		};
	}

	async getDeliveryStatus(_externalId: string): Promise<DeliveryStatus> {
		// Chat messages are delivered instantly via Convex real-time
		return 'delivered';
	}

	async validateSignature(_headers: Record<string, string>, _body: string): Promise<boolean> {
		// Chat uses Convex auth — no webhook signature needed
		return true;
	}

	async healthCheck(): Promise<ChannelHealth> {
		// Native channel is always healthy if the Convex backend is running
		return { status: 'healthy' };
	}
}
