/**
 * The MEASUREMENT half of a classified SMTP response.
 *
 * A sibling of `outcomeEvent.ts` and `outcomeDeliveryDomain.ts` rather than more
 * lines in `outcome.ts` (CONVENTIONS' ~500 LOC guideline), and one subject per
 * file: the reducer decides what a response MEANS for the message, and this
 * decides what it means for the ramp's measurement of the cell.
 */

import type { DispatchEffect } from './effects.js';
import type { DispatchOutcome } from './outcomeClassification.js';
import type { AttemptCtx } from './types.js';

/**
 * THE MEASUREMENT HALF OF A CLASSIFIED RESPONSE — one `notify_convex` effect
 * carrying the classifier's category as a TYPED field, emitted by BOTH deferral
 * branches and by the 5xx hard bounce.
 *
 * WHY ALL THREE, and why this is not a field on `bounced`. The ramp's gate-2
 * block clause divides refusals by classified responses. The terminal branches
 * (a non-retryable 4xx, and every 5xx hard bounce such as a `550 5.7.1 ...
 * blocked`) carry most of the numerator (`content_rejected`, `policy_rejected`),
 * and the retryable deferral carries the rest of the denominator (greylisting,
 * throttling, a full mailbox) — so reporting only the branches that already talk
 * to Convex would deliver a numerator with no denominator, read as a 100% block
 * rate, and halt a healthy cell on its first refusal. That is why the category
 * travels on its own event rather than as a field on the bounce beside it
 * (issue #501).
 *
 * IT CARRIES NO CELL AND NO ARM, deliberately. This service knows the
 * destination provider and nothing about the stream or which arm carried the
 * recipient; that is a property of the `sendAssignments` row, and Convex resolves
 * it there through the one join every other outcome goes through. A cell guessed
 * here would be a second answer to a question that already has one.
 */
export function classifiedResponseEffect(
	outcome: Extract<DispatchOutcome, { kind: 'hard_bounce' | 'deferred' }>,
	ctx: AttemptCtx
): DispatchEffect {
	return {
		kind: 'notify_convex',
		event: {
			event: 'smtp.classified',
			messageId: ctx.job.messageId,
			organizationId: ctx.job.organizationId,
			destinationProvider: ctx.destination.providerKey,
			smtpCategory: outcome.classification.category,
			timestamp: Date.now(),
		},
	};
}
