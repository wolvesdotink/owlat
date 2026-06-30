/**
 * topic.unsubscribed — fired when a contact unsubscribes from one or more
 * topics.
 *
 * Customer-facing contract: see docs/webhook-payloads.md. `listsRemoved`
 * is JSON-encoded as a string field because the current payload version
 * (1) requires flat primitives; a future payload v2 may relax this.
 */

import { v, type Infer } from 'convex/values';
import type { Id } from '../../../_generated/dataModel';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	contactId: v.string(),
	email: v.string(),
	unsubscribedAt: v.number(),
	listsRemoved: v.string(),
});

type Data = Infer<typeof schema>;

interface ListEntry {
	topicId: string;
	topicName: string;
}

interface Input {
	contactId: Id<'contacts'>;
	email: string;
	unsubscribedAt: number;
	lists: ListEntry[];
}

export const topicUnsubscribed: WebhookEventModule<
	'topic.unsubscribed',
	Input,
	Data
> = {
	literal: 'topic.unsubscribed',
	description: 'Contact unsubscribed from one or more topics',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			contactId: String(input.contactId),
			email: input.email,
			unsubscribedAt: input.unsubscribedAt,
			listsRemoved: JSON.stringify(input.lists),
		};
	},
};
