/**
 * email.sent — fired when a campaign or transactional email is dispatched
 * to the sending provider.
 *
 * `transactionalEmailId` is the TEMPLATE id, the same value as `templateId`.
 * The send API answers with a field of the same name that holds the SEND id,
 * which is why every email event also carries `sendId`; receivers match on
 * that. The template-id field stays for receivers that already read it.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';
import { sendIdentityData, sendIdentityFields, type SendIdentity } from '../sendIdentity';

const schema = v.object({
	email: v.string(),
	...sendIdentityFields,
	transactionalEmailId: v.union(v.string(), v.null()),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	identity: SendIdentity;
	at: number;
}

export const emailSent: WebhookEventModule<'email.sent', Input, Data> = {
	literal: 'email.sent',
	description: 'Email handed to the sending provider',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			...sendIdentityData(input.identity),
			transactionalEmailId: input.identity.templateId,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
