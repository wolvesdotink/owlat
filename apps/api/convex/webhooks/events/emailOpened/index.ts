/**
 * email.opened — fired on first open (tracked via 1x1 pixel beacon).
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';

const schema = v.object({
	email: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
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
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
