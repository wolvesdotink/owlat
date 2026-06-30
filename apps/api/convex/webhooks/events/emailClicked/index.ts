/**
 * email.clicked — fired on each link click (via tracked URL redirect).
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	email: v.string(),
	url: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	url: string;
	at: number;
}

export const emailClicked: WebhookEventModule<'email.clicked', Input, Data> = {
	literal: 'email.clicked',
	description: 'Recipient clicked a tracked link',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			url: input.url,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
