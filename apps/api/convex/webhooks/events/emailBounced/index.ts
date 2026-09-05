/**
 * email.bounced — fired on hard or soft bounce reported by the provider.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';
import { bounceTypeValidator } from '../../../lib/convexValidators';

const schema = v.object({
	email: v.string(),
	bounceType: bounceTypeValidator,
	message: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	bounceType: 'hard' | 'soft';
	message?: string;
	at: number;
}

export const emailBounced: WebhookEventModule<'email.bounced', Input, Data> = {
	literal: 'email.bounced',
	description: 'Sending provider reported a bounce',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			bounceType: input.bounceType,
			message: input.message ?? '',
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
