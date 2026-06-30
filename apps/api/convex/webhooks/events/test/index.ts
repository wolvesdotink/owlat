/**
 * test — fired by the `sendTestWebhook` mutation to validate a receiver
 * endpoint. Synthetic event: not customer-subscribable.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { Id } from '../../../_generated/dataModel';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	message: v.string(),
	webhookId: v.string(),
	webhookName: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	webhookId: Id<'webhooks'>;
	webhookName: string;
}

const STATIC_TEST_MESSAGE = 'This is a test webhook from Owlat';

export const test: WebhookEventModule<'test', Input, Data> = {
	literal: 'test',
	description: 'Test fire from the webhook dashboard',
	isSubscribable: false,
	schema,
	build(input) {
		return {
			message: STATIC_TEST_MESSAGE,
			webhookId: String(input.webhookId),
			webhookName: input.webhookName,
		};
	},
};
