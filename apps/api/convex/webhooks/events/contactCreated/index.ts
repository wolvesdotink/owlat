/**
 * contact.created — fired when a new contact is added via API, form,
 * import, transactional, or inbound channels.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { Id } from '../../../_generated/dataModel';
import type { WebhookEventModule } from '../../types';

const sourceValidator = v.union(
	v.literal('api'),
	v.literal('import'),
	v.literal('form'),
	v.literal('transactional'),
	v.literal('inbound')
);

const schema = v.object({
	contactId: v.string(),
	email: v.string(),
	source: sourceValidator,
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	contactId: Id<'contacts'>;
	email: string;
	source: 'api' | 'import' | 'form' | 'transactional' | 'inbound';
	at: number;
}

export const contactCreated: WebhookEventModule<
	'contact.created',
	Input,
	Data
> = {
	literal: 'contact.created',
	description: 'New contact added to the organization',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			contactId: String(input.contactId),
			email: input.email,
			source: input.source,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
