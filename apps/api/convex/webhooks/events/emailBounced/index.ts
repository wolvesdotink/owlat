/**
 * email.bounced — fired on hard or soft bounce reported by the provider.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';
import { sendIdentityData, sendIdentityFields, type SendIdentity } from '../sendIdentity';
import { bounceTypeValidator } from '../../../lib/literalValidators';

const schema = v.object({
	email: v.string(),
	...sendIdentityFields,
	bounceType: bounceTypeValidator,
	message: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	identity: SendIdentity;
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
			...sendIdentityData(input.identity),
			bounceType: input.bounceType,
			message: input.message ?? '',
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
