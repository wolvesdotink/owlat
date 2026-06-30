/**
 * email.delivered — fired when the receiving MTA accepts delivery.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	email: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	at: number;
}

export const emailDelivered: WebhookEventModule<
	'email.delivered',
	Input,
	Data
> = {
	literal: 'email.delivered',
	description: 'Sending provider reported successful delivery',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
