/** Shared delivery-log fields for every post-SMTP Dispatch outcome. */

import type { DeliveryEvent } from '../monitoring/deliveryLogger.js';
import type { AttemptCtx } from './types.js';

type OutcomeEventBase = Pick<
	DeliveryEvent,
	'messageId' | 'to' | 'from' | 'orgId' | 'ip' | 'pool' | 'domain' | 'provider' | 'durationMs'
>;

export function outcomeEventBase(ctx: AttemptCtx): OutcomeEventBase {
	return {
		messageId: ctx.job.messageId,
		to: ctx.job.to,
		from: ctx.job.from,
		orgId: ctx.job.organizationId,
		ip: ctx.ip,
		pool: ctx.pool,
		domain: ctx.domain,
		provider: ctx.providerKey,
		durationMs: ctx.durationMs,
	};
}
