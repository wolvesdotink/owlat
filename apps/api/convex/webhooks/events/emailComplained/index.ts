/**
 * email.complained — fired when a recipient marks the email as spam
 * (feedback loop from provider).
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

export const emailComplained: WebhookEventModule<'email.complained', Input, Data> = {
	literal: 'email.complained',
	description: 'Recipient marked the email as spam',
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
