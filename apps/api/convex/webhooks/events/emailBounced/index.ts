/**
 * email.bounced — fired on hard or soft bounce reported by the provider.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';
import { sendIdentityData, sendIdentityFields, type SendIdentity } from '../sendIdentity';
import { bounceCauseValidator, bounceTypeValidator } from '../../../lib/literalValidators';

const schema = v.object({
	email: v.string(),
	...sendIdentityFields,
	bounceType: bounceTypeValidator,
	cause: bounceCauseValidator,
	message: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	identity: SendIdentity;
	bounceType: 'hard' | 'soft';
	/**
	 * `sender`: nothing shows the address is at fault (the receiver refused our
	 * sending identity, or a relay neither blamed the recipient nor reported the
	 * address failed), so Owlat did not blocklist it. A receiver must not suppress the address on it.
	 */
	cause: 'recipient' | 'sender';
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
			cause: input.cause,
			message: input.message ?? '',
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
