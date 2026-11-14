/**
 * email.failed — fired once when a send reaches the terminal `failed` state:
 * the provider refused it, a delivery hold outlived the delivery deadline, or
 * the worker could not hand it over. A bounce is not a failure and has its own
 * event; a send that is held or retried fires nothing until it settles. A
 * campaign or automation send skipped at dispatch because its recipient is
 * suppressed, unsubscribed or deleted fires nothing; an API send skipped that
 * way still does (`reduceFailed` in `delivery/sendLifecycle/reducers.ts`).
 *
 * `errorCode` is the stable code the send row records (`MTA_UNREACHABLE`,
 * `DELIVERY_HOLD_EXPIRED`, `RECIPIENT_SUPPRESSED`, ...). Receivers branch on
 * it; `message` is for people.
 *
 * Customer-facing contract: see docs/webhook-payloads.md.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventModule } from '../../types';
import { sendIdentityData, sendIdentityFields, type SendIdentity } from '../sendIdentity';

const schema = v.object({
	email: v.string(),
	...sendIdentityFields,
	errorCode: v.string(),
	message: v.string(),
	timestamp: v.string(),
});

type Data = Infer<typeof schema>;

interface Input {
	email: string;
	identity: SendIdentity;
	errorCode: string;
	message: string;
	at: number;
}

export const emailFailed: WebhookEventModule<'email.failed', Input, Data> = {
	literal: 'email.failed',
	description: 'Email could not be sent and will not be retried',
	isSubscribable: true,
	schema,
	build(input) {
		return {
			email: input.email,
			...sendIdentityData(input.identity),
			errorCode: input.errorCode,
			message: input.message,
			timestamp: new Date(input.at).toISOString(),
		};
	},
};
