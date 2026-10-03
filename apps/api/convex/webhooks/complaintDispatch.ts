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
import { isSendNotFound, recordUnresolvedFeedback } from './unresolvedBounce';
import { observeYahooCflReport } from './yahooCflObservation';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { tagsFeedbackProvenanceFor } from '../lib/sendProviders/catalog';
import { isSendProviderKind } from '../lib/sendProviders/types';
import type { UnresolvedFeedbackSuppression } from '../lib/literalValidators';

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
	//
	// ASK WHETHER THE SOURCE TAGS ITS FEEDBACK, don't name the provider. This
	// used to read `e.providerType === 'ses' || e.deliveryDomain === 'production'`
	// — SES by name, for a property SES shares with every third-party ESP: nobody
	// annotates their webhook with our `deliveryDomain`, because that tag is
	// written on the way out of our own infrastructure and nothing else. So a
	// byte-identical redacted complaint from Mandrill, an SMTP relay's FBL or a
	// plugin ESP was DROPPED, and the complainer stayed mailable.
	//
	// Both directions are load-bearing. A tagged source must show `production`:
	// the tag's one writer stamps it only on an exactly-VERP-attributed report
	// and drops the effect list on `unknown` provenance, so it is the evidence
	// that this complaint is about real production mail rather than member-preview
	// mail or an unattributed guess. An untagged source has no tag to show, so
	// requiring one would suppress nothing it ever reports.
	//
	// A SOURCE WE CANNOT IDENTIFY is neither, and requires the tag. An event with
	// no `providerType` (or one naming a kind this deployment does not have)
	// carries no evidence about who observed it, and blocklisting an address on
	// an unattributable report is the one error here that is invisible and
	// permanent — the recipient simply stops receiving mail.
	if (!e.providerMessageId) {
		const source = isSendProviderKind(e.providerType) ? e.providerType : null;
		const needsProvenanceTag = source === null || tagsFeedbackProvenanceFor(source);
		if (e.recipient && (!needsProvenanceTag || e.deliveryDomain === 'production')) {
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
		if (isSendNotFound(outcome)) {
			// The id names no Send (#1194): the provider id was never stored, or the
			// mail was not sent by this deployment at all. The complaint is stored
			// for replay either way; the named address is blocked only on proof.
			const suppression = await suppressUnresolvedComplainer(ctx, e);
			await recordUnresolvedFeedback(
				ctx,
				{ ...e, providerMessageId: e.providerMessageId },
				{ suppression }
			);
		}
	}
	await observeYahooCflReport(ctx, e);
}

/**
 * Block the address an unresolved complaint names ONLY when the event proves
 * this deployment sent the mail it is about.
 *
 * STRICTER THAN THE REDACTED BRANCH ABOVE, on purpose. A Message-ID that
 * matches no Send is itself evidence the mail may not be ours: a provider
 * account, webhook or SNS topic shared by several deployments delivers every
 * tenant's feedback to each of them, and the webhook signature proves the
 * PROVIDER sent the report, not which deployment sent the mail. Blocking on
 * that would let one tenant's complaint permanently silence the address for
 * another, invisibly.
 *
 * The one proof available today is the provenance tag our own infrastructure
 * writes: `deliveryDomain: 'production'` from a source that declares
 * `tagsFeedbackProvenance` (the MTA), stamped only on a report whose signed VERP
 * token decoded, i.e. on mail this deployment's key signed. SES, Resend and
 * Mandrill echo back no marker Owlat stamps per deployment (no message tag,
 * metadata or header the adapters could read), so their unresolved complaints
 * are stored as `unattributed` and never block an address. An unidentifiable
 * source proves nothing either.
 */
async function suppressUnresolvedComplainer(
	ctx: ActionCtx,
	e: InboundEventOf<'email.complained'>
): Promise<UnresolvedFeedbackSuppression> {
	if (!e.recipient) return 'no_recipient';
	if (!isAttributedToThisDeployment(e)) return 'unattributed';
	await ctx.runMutation(internal.blockedEmails.addFromEvent, {
		email: e.recipient,
		reason: 'complained',
	});
	return 'suppressed';
}

function isAttributedToThisDeployment(e: InboundEventOf<'email.complained'>): boolean {
	return (
		isSendProviderKind(e.providerType) &&
		tagsFeedbackProvenanceFor(e.providerType) &&
		e.deliveryDomain === 'production'
	);
}
