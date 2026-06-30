/**
 * @owlat/channels — communication channel adapters
 *
 * Each adapter normalizes a different transport (email/MTA, SMS/Twilio,
 * WhatsApp/Meta, generic webhooks, native Convex chat) into the unified
 * ChannelAdapter interface defined in ./types.
 *
 * @example
 * ```typescript
 * import { EmailAdapter, SmsAdapter, type ChannelAdapter } from '@owlat/channels';
 *
 * const adapters: ChannelAdapter[] = [
 *   new EmailAdapter(),
 *   new SmsAdapter(),
 * ];
 * ```
 */

export type {
	ChannelType,
	OutboundMessage,
	SendResult,
	ParsedMessage,
	DeliveryStatus,
	ChannelHealth,
	ChannelAdapter,
} from './types';

export { EmailAdapter } from './email';
export { SmsAdapter } from './sms';
export { WhatsAppAdapter } from './whatsapp';
export { WebhookAdapter } from './webhook';
export { ChatAdapter } from './chat';

export {
	type InboundEmailMessage,
	type InboundSource,
	type InboundChannelAdapter,
	MtaInboundAdapter,
	ResendInboundAdapter,
	getInboundChannelAdapter,
	registerInboundChannelAdapter,
} from './inboundRegistry';
