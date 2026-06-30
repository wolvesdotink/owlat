/**
 * email.sent — fired when a campaign or transactional email is dispatched
 * to the sending provider.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { Id } from '../../../_generated/dataModel';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	email: v.string(),
	campaignId: v.union(v.string(), v.null()),
	transactionalEmailId: v.union(v.string(), v.null()),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	campaignId?: Id<'campaigns'> | null;
	transactionalEmailId?: Id<'transactionalEmails'> | null;
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
			campaignId: input.campaignId ?? null,
			transactionalEmailId: input.transactionalEmailId ?? null,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
