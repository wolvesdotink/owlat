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
 *
 * OPERATOR DECISIONS WIN OVER OLDER PROVIDER DATA (#1228). Every write carries
 * the event's own time. `addFromEvent` refuses a re-add older than an
 * operator's removal of that address, and `processUnsubscribeByEmail` refuses
 * an unsubscribe older than the contact's re-subscribe, so a late redelivery or
 * a replay cannot undo either. A NEWER event still applies: if the provider
 * keeps refusing the address after the operator unblocked it, that is fresh
 * evidence, and the fix is to remove it from the provider's list too.
 *
 * WHY THERE IS NO OWNERSHIP GATE HERE, unlike the unresolved-complaint path
 * (#1214, #1237). Those complaints name a message that matches no Send, which
 * is itself evidence the mail may not be ours. A provider suppression is a fact
 * about the provider ACCOUNT's list, and this deployment's arm on that account
 * refuses the address whoever put it there, so mirroring it keeps the two arms
 * on the same population. It also cannot be gated on the Send: Mandrill refuses
 * a listed address synchronously, and a refused send stores no provider message
 * id for the webhook's `reject` to match. That synchronous refusal is mirrored
 * from the send response itself ({@link recordSendResponseRefusal}). Events
 * from another Mandrill subaccount are held back before they reach this file
 * (`./sendingScope.ts`, #1243).
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { logError } from '../lib/runtimeLog';
import type { InboundEventOf, ProviderSuppression, ProviderSuppressionReason } from './types';

/** What the host does about one suppression reason. */
type ProviderSuppressionEffect =
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
 * present. Both writes are idempotent per address while nothing changes, and
 * both refuse an event older than a later operator removal or re-subscribe,
 * which is what makes a redelivered batch a no-op even after one of those.
 */
async function applyProviderSuppressionFact(
	ctx: ActionCtx,
	fact: { providerType: string; recipient: string; at: number },
	suppression: ProviderSuppression,
	source: 'webhook' | 'send_response' = 'webhook'
): Promise<void> {
	const { providerType, recipient, at } = fact;
	const effect = providerSuppressionEffect(suppression.reason);
	if (effect.kind === 'unsubscribe') {
		await ctx.runMutation(internal.delivery.unsubscribeQueries.processUnsubscribeByEmail, {
			email: recipient,
			eventAt: at,
		});
		return;
	}
	await ctx.runMutation(internal.blockedEmails.addFromEvent, {
		email: recipient,
		reason: effect.reason,
		eventAt: at,
		...(effect.reason === 'bounced' ? { bounceType: effect.bounceType } : {}),
		provenance: {
			provider: providerType,
			source,
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
	await applyProviderSuppressionFact(ctx, event, {
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
	await applyProviderSuppressionFact(
		ctx,
		{ providerType: event.providerType, recipient: event.recipient, at: event.at },
		event.suppression
	);
}

/**
 * Mirror the suppression a provider attached to a refusal in its own send
 * response (#1243): a Mandrill `rejected` result off its reject list. Every
 * caller of `sendProviderDispatch` passes its result here (the governed
 * dispatch and system mail; `__tests__/sendResponseRefusalCallers.test.ts`
 * fails a new caller that does not).
 *
 * The message is ours by construction (our key, our request), so no ownership
 * question arises, and it is the same fact the provider's `reject` webhook
 * would report later, applied through the same table and the same event-time
 * guards, at the response time. It touches no Send, so completion and the
 * lost-send sweep are unaffected, and it runs before the caller reports the
 * failure, so a lost completion changes nothing here.
 *
 * NEVER THROWS. A write that fails is logged; the caller's own failure (the
 * provider's error) is what the send reports.
 */
export async function recordSendResponseRefusal(
	ctx: ActionCtx,
	args: {
		result: { success: boolean; suppression?: ProviderSuppression };
		providerType: string;
		recipient: string;
	}
): Promise<void> {
	const { result, providerType, recipient } = args;
	if (result.success || !result.suppression) return;
	try {
		await applyProviderSuppressionFact(
			ctx,
			{ providerType, recipient, at: Date.now() },
			result.suppression,
			'send_response'
		);
	} catch (error) {
		logError('[Provider Suppression] send-response refusal could not be mirrored', {
			providerType,
			reason: result.suppression.reason,
			errorName: error instanceof Error ? error.name : typeof error,
		});
	}
}
