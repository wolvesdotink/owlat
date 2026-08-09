/**
 * WHAT OWLAT DOES ABOUT A PROVIDER'S OWN SUPPRESSION — one table, every
 * provider.
 *
 * A send provider that keeps a suppression list is reporting recipient truth
 * that only IT enforces. During a measured migration that matters twice over: a
 * relay's list is years of accumulated evidence the own arm knows nothing
 * about, so without mirroring it the ramp controller moves traffic onto an MTA
 * that happily mails addresses the reference arm has refused since 2023 — and
 * then reads the bounces and complaints it earns as "our MTA is worse".
 * Mirroring the hit into `blockedEmails` (and, through the shipped
 * `scheduleSuppressionMirror`, into the MTA's Redis backstop) is what keeps the
 * two arms sending to the same population.
 *
 * THE SPLIT THIS FILE EXISTS FOR. Every provider spells its own reasons
 * (Mandrill's ten `reject_reason`s, Emailit's free-text `status`, whatever a
 * plugin's provider publishes). Those spellings are translated ONCE, in the
 * adapter that knows the vendor, into the closed
 * {@link ProviderSuppressionReason} vocabulary. What Owlat then DOES about each
 * member is decided here, for everyone, so the consequence of "this mailbox is
 * gone" cannot differ by which relay reported it — and so the next provider
 * with a suppression policy is a table in its own adapter, not a line in the
 * dispatch table.
 *
 * WHICH CONSEQUENCE, AND WHY:
 *
 *  - `hard_bounce` / `invalid_recipient` — the mailbox itself failed
 *    permanently. Suppress as `bounced` + `hard`, the classification the MTA
 *    mirror turns into a permanent backstop entry (`toMtaSuppressionReason`).
 *  - `soft_bounce` — a provider only blacklists on soft failures after days of
 *    retrying, so the address IS evidence, but a recoverable one: it rides the
 *    soft classification the MTA mirror expires (the same shape the shipped
 *    soft-bounce escalation writes in `feedbackReducers.ts`).
 *  - `spam_complaint` — this person complained. Suppress as `complained`, the
 *    same class an FBL report earns, and with NO bounce classification: sending
 *    one would make the MTA mirror describe a spam report as a mailbox failure.
 *  - `recipient_rejected` / `recipient_blacklisted` / `operator_suppressed` —
 *    the provider (or an operator, or an account rule) put the address on a
 *    list. That is a decision rather than an observation, so it maps to
 *    `manual`: the one reason whose MTA mirror expires and whose presence on
 *    the suppression screen reads as "someone put this here".
 *  - `unsubscribed` — the person left. Owlat has a whole consent path for that
 *    (membership delete, opt-out stamp, campaign counter, webhook fanout); a
 *    blocklist row would record the outcome while skipping the accounting, so
 *    this routes to the unsubscribe path INSTEAD. Adapters that also map a
 *    first-class unsubscribe EVENT send the same fact down the same mutation,
 *    which is idempotent — the two paths meeting on one address is a no-op, not
 *    a double count.
 *
 * There is deliberately no `ignore` member: a reason that says nothing about
 * the recipient is one an adapter never mints, so it cannot arrive here and be
 * mishandled.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { InboundEventOf, ProviderSuppression, ProviderSuppressionReason } from './types';

/** What the host does about one suppression reason. */
export type ProviderSuppressionEffect =
	| { readonly kind: 'block'; readonly reason: 'bounced'; readonly bounceType: 'hard' | 'soft' }
	| { readonly kind: 'block'; readonly reason: 'complained' | 'manual' }
	| { readonly kind: 'unsubscribe' };

/**
 * Reason → effect, exhaustive by construction.
 *
 * `Record<ProviderSuppressionReason, …>` rather than a lookup with a fallback:
 * a member added to the vocabulary without a decision here is a compile error,
 * not an address that quietly stops being suppressed.
 */
const SUPPRESSION_EFFECTS: Readonly<Record<ProviderSuppressionReason, ProviderSuppressionEffect>> =
	{
		invalid_recipient: { kind: 'block', reason: 'bounced', bounceType: 'hard' },
		hard_bounce: { kind: 'block', reason: 'bounced', bounceType: 'hard' },
		soft_bounce: { kind: 'block', reason: 'bounced', bounceType: 'soft' },
		spam_complaint: { kind: 'block', reason: 'complained' },
		recipient_rejected: { kind: 'block', reason: 'manual' },
		recipient_blacklisted: { kind: 'block', reason: 'manual' },
		operator_suppressed: { kind: 'block', reason: 'manual' },
		unsubscribed: { kind: 'unsubscribe' },
	};

/**
 * The host's decision for one reason.
 *
 * Pure, so the whole policy is testable without a ctx — and so the OTHER door a
 * provider's suppression list arrives through (the one-off carry-over at
 * migration time, `integrationImports/providers/*`) reads the same table the
 * ongoing webhook feed does. Two tables would drift silently: an address
 * carried over as `manual` and later re-reported as `complained` reads as an
 * operator's decision forever.
 */
export function providerSuppressionEffect(
	reason: ProviderSuppressionReason
): ProviderSuppressionEffect {
	return SUPPRESSION_EFFECTS[reason];
}

/**
 * Apply one provider's suppression fact about one recipient.
 *
 * The address is UNTRUSTED provider telemetry — it is acted on because the
 * SIGNED callback said this provider suppressed it, never because the field was
 * present. Both writes are idempotent per address, which is what makes a
 * redelivered batch a no-op rather than a second row or a second count.
 */
async function applyProviderSuppressionFact(
	ctx: ActionCtx,
	providerType: string,
	recipient: string,
	suppression: ProviderSuppression
): Promise<void> {
	const effect = providerSuppressionEffect(suppression.reason);
	if (effect.kind === 'unsubscribe') {
		await ctx.runMutation(internal.delivery.unsubscribeQueries.processUnsubscribeByEmail, {
			email: recipient,
		});
		return;
	}
	await ctx.runMutation(internal.blockedEmails.addFromEvent, {
		email: recipient,
		reason: effect.reason,
		...(effect.reason === 'bounced' ? { bounceType: effect.bounceType } : {}),
		provenance: {
			provider: providerType,
			source: 'webhook' as const,
			// The provider's own code where it published one; otherwise the host's
			// rendering of the reason, which is what every pre-`evidence` caller
			// (Emailit, every plugin) has always recorded.
			evidence: suppression.evidence ?? `PROVIDER_SUPPRESSED_${suppression.reason.toUpperCase()}`,
		},
	});
}

/** Apply an allowlisted recipient-specific suppression reported by a provider. */
export async function applyProviderSuppression(
	ctx: ActionCtx,
	event: InboundEventOf<'email.provider_suppressed'>
): Promise<void> {
	await applyProviderSuppressionFact(ctx, event.providerType, event.recipient, {
		reason: event.reason,
		...(event.evidence ? { evidence: event.evidence } : {}),
	});
}

/**
 * Apply the suppression a terminal failure carries, if it carries one.
 *
 * Called by the dispatcher BEFORE the lifecycle transition, on the
 * `complaintDispatch` principle: the recipient-protecting write runs first, so
 * a failure in the bookkeeping half can never be the reason an address a
 * provider refuses stays mailable on ours.
 *
 * Three guards, all of which have to hold: the event's adapter has to have
 * minted a suppression, the event has to name an address, and it has to name
 * the provider the suppression is attributed to — an unattributed blocklist row
 * is one no operator can trace back to the list it mirrors. Everything else —
 * every ordinary failure, from every provider — acknowledges and does nothing.
 */
export async function applyFailureSuppression(
	ctx: ActionCtx,
	event: InboundEventOf<'email.failed'>
): Promise<void> {
	if (!event.suppression || !event.recipient || !event.providerType) return;
	await applyProviderSuppressionFact(ctx, event.providerType, event.recipient, event.suppression);
}
