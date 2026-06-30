/**
 * email.complained — fired when a recipient marks the email as spam
 * (feedback loop from provider).
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

export const emailComplained: WebhookEventModule<
	'email.complained',
	Input,
	Data
> = {
	literal: 'email.complained',
	description: 'Recipient marked the email as spam',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
