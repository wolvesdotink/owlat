/**
 * Unresolved-feedback capture (M3AAWG "measure unattributable feedback").
 *
 * Its own module rather than a function inside `dispatcher.ts` so that both
 * negative-signal handlers — the inline `email.bounced` one and the extracted
 * `email.complained` one in `complaintDispatch.ts` — share ONE implementation
 * without the dispatcher having to export anything back to its own handlers.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { TransitionOutcome } from '../delivery/sendLifecycle';
import type { UnresolvedFeedbackSuppression } from '../lib/literalValidators';
import { logError, logWarn } from '../lib/runtimeLog';
import type { InboundEventOf } from './types';

/**
 * `transitionByProviderMessageId` returns `{ ok: false, reason:
 * 'send_not_found' }` when a provider message id resolves to no Send row. Only
 * that outcome is a signal; success, any other refusal and an absent return
 * are not.
 */
export function isSendNotFound(outcome: TransitionOutcome | undefined): boolean {
	return outcome !== undefined && !outcome.ok && outcome.reason === 'send_not_found';
}

type UnresolvedEvent =
	| InboundEventOf<'email.bounced'>
	| (InboundEventOf<'email.complained'> & { providerMessageId: string });

/**
 * Keep a negative signal whose provider message id matched no Send (#1194).
 *
 * For `email.bounced` / `email.complained` the silent ack hid a real failure
 * class: a bounce the MTA attributed (so the worker-side unattributed-bounce
 * counter never fires) but which is lost at the Convex resolve step, e.g. the
 * VERP-token-vs-stored-providerMessageId mismatch (PR-01), or a send whose
 * provider id never got stored (#1184). So:
 *
 *  - a structured `unresolved_bounce` warning goes to the function log, as
 *    before, carrying the event kind and provider message id but never an
 *    address, so log-based alerts keep working;
 *  - the event is stored in `unresolvedFeedback`, where an operator can count
 *    it and a replay can apply it once the id resolves.
 *
 * NEVER THROWS. A store that fails is logged and the webhook is acknowledged,
 * as it was before this table existed: a provider batch must not be retried
 * forever, and held up behind it, because of the bookkeeping.
 */
export async function recordUnresolvedFeedback(
	ctx: ActionCtx,
	e: UnresolvedEvent,
	options: { suppression: UnresolvedFeedbackSuppression } = { suppression: 'not_applicable' }
): Promise<void> {
	logWarn(
		`[Webhook Dispatcher] unresolved_bounce: ${e.kind} for providerMessageId ` +
			`${e.providerMessageId} resolved to no Send row (at=${e.at}). Stored in ` +
			`unresolvedFeedback for replay — measure-unattributable-feedback.`
	);
	const signal =
		e.kind === 'email.bounced'
			? {
					kind: 'bounce' as const,
					bounceType: e.bounceType,
					...(e.bounceMessage ? { bounceMessage: e.bounceMessage } : {}),
				}
			: {
					kind: 'complaint' as const,
					...(e.recipient ? { recipient: e.recipient } : {}),
				};
	try {
		await ctx.runMutation(internal.webhooks.unresolvedFeedback.record, {
			...signal,
			providerMessageId: e.providerMessageId,
			at: e.at,
			suppression: options.suppression,
			...(e.providerType ? { providerType: e.providerType } : {}),
			...(e.deliveryDomain ? { deliveryDomain: e.deliveryDomain } : {}),
		});
	} catch (error) {
		// The error text is not logged: a validator error quotes the document it
		// refused, and this one can carry the complainer's address.
		logError('[Webhook Dispatcher] unresolved feedback could not be stored', {
			kind: e.kind,
			providerMessageId: e.providerMessageId,
			errorName: error instanceof Error ? error.name : typeof error,
		});
	}
}
