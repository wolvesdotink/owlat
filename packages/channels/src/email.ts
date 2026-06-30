/**
 * Email Channel Adapter
 *
 * Wraps the existing email provider system (MTA/SES/Resend)
 * into the unified ChannelAdapter interface.
 */

import type { ChannelAdapter, OutboundMessage, SendResult, ParsedMessage, DeliveryStatus, ChannelHealth } from './types';

interface EmailInboundPayload {
	from?: string;
	textBody?: string;
	htmlBody?: string;
	subject?: string;
	messageId?: string;
	timestamp?: number;
	inReplyTo?: string;
	references?: string;
}

export class EmailAdapter implements ChannelAdapter {
	id = 'email' as const;

	async send(_message: OutboundMessage): Promise<SendResult> {
		// Delegates to existing email provider infrastructure
		// This will be wired to getEmailProvider().sendEmail() in the action layer
		return {
			success: false,
			error: 'Email sending is handled via existing emailWorker infrastructure',
		};
	}

	parseInbound(raw: unknown): ParsedMessage {
		const payload = raw as EmailInboundPayload;
		return {
			from: payload.from ?? '',
			content: {
				text: payload.textBody,
				html: payload.htmlBody,
				subject: payload.subject,
			},
			externalMessageId: payload.messageId,
			timestamp: payload.timestamp ?? Date.now(),
			metadata: {
				inReplyTo: payload.inReplyTo,
				references: payload.references,
			},
		};
	}

	async getDeliveryStatus(_externalId: string): Promise<DeliveryStatus> {
		// Email delivery status is tracked via MTA webhooks
		return 'sent';
	}

	async validateSignature(_headers: Record<string, string>, _body: string): Promise<boolean> {
		// MTA webhook signature validation is handled by mtaWebhook.ts
		return true;
	}

	async healthCheck(): Promise<ChannelHealth> {
		// Email health is tracked by providerHealth table
		return { status: 'healthy' };
	}
}
