/**
 * The `email.complained` handler, extracted from the dispatch table.
 *
 * Its own module rather than an inline arrow in `dispatcher.ts`: the dispatcher
 * is a routing TABLE, and this is the one handler whose branch structure needs a
 * policy docblock of its own (CONVENTIONS.md — split a feature file rather than
 * growing it). Same shape as `yahooCflObservation.ts`, which it calls.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { isPostboxMessageId } from '../delivery/messageIdRouting';
import type { TransitionOutcome } from '../delivery/sendLifecycle';
import type { InboundEventOf } from './types';
import { recordUnresolvedBounce } from './unresolvedBounce';
import { observeYahooCflReport } from './yahooCflObservation';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';

/**
 * SUPPRESSION FIRST, bookkeeping second. A complaint must always reach the
 * blocklist, so the two attribution branches run to completion before the
 * feedback-loop observation is even attempted.
 */
export async function dispatchComplaint(
	ctx: ActionCtx,
	e: InboundEventOf<'email.complained'>
): Promise<void> {
	// Recipient-only complaint (RFC 5965 §3.2): the FBL redacted the
	// original Message-ID (e.g. Gmail), so there's no send to transition.
	// Suppress the complainer directly by email — a complaint must always
	// reach the blocklist, never evaporate into a metric.
	if (!e.providerMessageId) {
		if (e.recipient && (e.providerType === 'ses' || e.deliveryDomain === 'production')) {
			await ctx.runMutation(internal.blockedEmails.addFromEvent, {
				email: e.recipient,
				reason: 'complained',
			});
		}
	} else if (isPostboxMessageId(e.providerMessageId)) {
		// SHIPPED SHORT-CIRCUIT, PRESERVED. A postbox-attributed complaint is not a
		// campaign send, so the shipped handler returned here without doing anything
		// further — and the feedback-loop observation must not become the one thing
		// that now runs on this path. Enrollment liveness is proved by ordinary
		// production complaints; this branch stays exactly as it shipped.
		return;
	} else {
		const outcome = (await ctx.runMutation(
			e.providerType === OWN_ARM_TRANSPORT_KIND
				? internal.delivery.sendLifecycle.transitionMtaByProviderMessageId
				: internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: e.providerMessageId,
				transition: { to: 'complained', at: e.at },
			}
		)) as TransitionOutcome;
		recordUnresolvedBounce('email.complained', e.providerMessageId, e.at, outcome);
	}
	await observeYahooCflReport(ctx, e);
}
