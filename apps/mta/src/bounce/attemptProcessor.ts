/** Apply one classified bounce attempt while preserving its SMTP retry semantics. */

import { logger } from '../monitoring/logger.js';
import { applyEffects } from './effects.js';
import {
	completeComplaint,
	releaseComplaint,
	runComplaintEffect,
	type ComplaintDedupReservation,
} from './fblProcessor.js';
import { attachFeedbackProvenance } from './feedbackProvenance.js';
import { reduce } from './outcome.js';
import { logAttempt } from './serverHelpers.js';
import { TransientFeedbackProcessingError } from './transientFeedbackError.js';
import type { BasePhaseCtx, BounceAttempt, PhaseDeps } from './types.js';

export async function processBounceAttempt(
	deps: PhaseDeps,
	attempt: BounceAttempt,
	ctx: BasePhaseCtx
): Promise<void> {
	const reservation = attempt.kind === 'fbl' ? attempt.dedupReservation : undefined;
	try {
		const attributedAttempt = await attachFeedbackProvenance(deps.redis, attempt);
		logAttempt(attributedAttempt, ctx.parsed);
		await applyEffects(
			reduce(attributedAttempt, ctx).effects,
			deps,
			reservation
				? {
						runSecondary: (effectIdentity, apply) =>
							runComplaintEffect(deps.redis, reservation, effectIdentity, apply),
					}
				: undefined
		);
		if (reservation) await completeComplaint(deps.redis, reservation);
	} catch (error) {
		if (reservation && error instanceof TransientFeedbackProcessingError) {
			await releaseReservation(deps, reservation);
		} else if (reservation) {
			// Generic effect failures are SMTP-ACKed. Durable callbacks run before
			// best-effort effects, so the dedup state must match that disposition.
			try {
				await completeComplaint(deps.redis, reservation);
			} catch (completionError) {
				await releaseReservation(deps, reservation);
				throw completionError;
			}
		}
		throw error;
	}
}

async function releaseReservation(
	deps: PhaseDeps,
	reservation: ComplaintDedupReservation
): Promise<void> {
	await releaseComplaint(deps.redis, reservation).catch((error) =>
		logger.error({ err: error }, 'Failed to release FBL deduplication reservation')
	);
}
