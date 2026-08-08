import type { MutationCtx } from '../../_generated/server';
import { transportOutcomeEffect, type Effect } from './effects';
import { senderDomainFor } from './lookups';
import type { EmailSendDoc, SendRef, TransactionalSendDoc, TransitionInput } from './reducers';
import { transportOutcomeEventForTransition } from '../../analytics/transportOutcomeSummary';

// ============================================================================
// The VOLUME-DENOMINATOR and DELIVERABILITY-OUTCOME effects of one transition.
//
// Split out of the dispatcher per CONVENTIONS.md: both blocks answer the same
// question — "what did this transition prove about the wire?" — and neither
// needs the dispatcher's reducer fan-out or its post-commit side effects. The
// dispatcher appends what these return to the SAME effect list the reducers
// produced, so both inherit its duplicate suppression and its test-send
// stripping.
// ============================================================================

/**
 * Whether an MTA terminal callback proves that an SMTP envelope was attempted.
 *
 * Bounce and complaint evidence necessarily follows an outbound attempt.
 * `ambiguous_post_data` is the one failed disposition emitted after message
 * data reached the wire. Other failed codes describe local policy, routing, or
 * intake failures and must not inflate sent-volume denominators.
 */
export function hasOutboundAttemptEvidence(input: TransitionInput): boolean {
	return (
		input.to === 'bounced' ||
		input.to === 'complained' ||
		(input.to === 'failed' && input.errorCode === 'ambiguous_post_data')
	);
}

/**
 * The `sent` accounting a `queued → terminal` MTA callback has to re-supply.
 *
 * An SMTP rejection or post-DATA ambiguity goes `queued → terminal` without
 * passing through `sent`, so `reduceSent`'s outbound accounting never runs.
 * Preserve the rate denominator only when the callback proves an envelope
 * attempt. Local screening, suppression, routing exhaustion, and intake
 * uncertainty are terminal non-deliveries, not sent volume. The `email.sent`
 * customer webhook deliberately stays with `reduceSent`: nothing here was
 * accepted for delivery.
 */
export async function queuedTerminalSendAccountingEffects(
	ctx: MutationCtx,
	args: {
		send: EmailSendDoc | TransactionalSendDoc;
		ref: SendRef;
		input: TransitionInput;
		/** The domain the delivery observation already resolved, if it did. */
		senderDomain: string | undefined;
	}
): Promise<Effect[]> {
	const { ref, input, send } = args;
	return [
		...(ref.kind === 'campaign'
			? ([
					{
						kind: 'campaign_stats_sent',
						campaignId: (send as EmailSendDoc).campaignId,
					},
				] as Effect[])
			: []),
		{ kind: 'daily_stats_bump', field: 'sent', at: input.at },
		{
			kind: 'reputation_update',
			eventType: 'send',
			domain: args.senderDomain ?? (await senderDomainFor(ctx, send, ref)),
		},
		// Same evidence rule as the reputation counter above it.
		transportOutcomeEffect(ref, 'sent', input.at),
	];
}

/**
 * The per-cell, per-arm DELIVERABILITY outcome of one transition (plan D5,
 * fixing G-05: acceptance is not delivery).
 *
 * `failed` maps to no event (a local non-delivery is not a transport outcome),
 * and neither do `delivered`/`opened`/`clicked` — those are emitted next to the
 * shipped counters they must agree with, see
 * `transportOutcomeEventForTransition`. Cell and arm are resolved by the effect
 * runner.
 */
export function transitionOutcomeEffects(ref: SendRef, input: TransitionInput): Effect[] {
	const event = transportOutcomeEventForTransition(
		input.to,
		input.to === 'bounced' ? input.bounceType : undefined
	);
	return event === null ? [] : [transportOutcomeEffect(ref, event, input.at)];
}
