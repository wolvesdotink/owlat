/**
 * email.delivered — fired when the receiving MTA accepts delivery.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';
import { sendIdentityData, sendIdentityFields, type SendIdentity } from '../sendIdentity';

const schema = v.object({
	email: v.string(),
	...sendIdentityFields,
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	identity: SendIdentity;
	at: number;
}

export const emailDelivered: WebhookEventModule<'email.delivered', Input, Data> = {
	literal: 'email.delivered',
	description: 'Sending provider reported successful delivery',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			...sendIdentityData(input.identity),
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
