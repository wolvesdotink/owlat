/**
 * email.opened — fired on first open (tracked via 1x1 pixel beacon).
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

export const emailOpened: WebhookEventModule<'email.opened', Input, Data> = {
	literal: 'email.opened',
	description: 'Recipient opened the email (tracking pixel)',
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
