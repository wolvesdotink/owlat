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

/**
 * SUPPRESSION FIRST, bookkeeping second. A complaint must always reach the
 * blocklist, so the two attribution branches run to completion before the
 * feedback-loop observation is even attempted.
 */
export async function dispatchComplaint(
	ctx: ActionCtx,
	e: InboundEventOf<'email.complained'>
): Promise<void> {
	if (!e.providerMessageId) {
		// Recipient-only complaint (RFC 5965 §3.2): the FBL redacted the
		// original Message-ID (e.g. Gmail), so there's no send to transition.
		// Suppress the complainer directly by email — a complaint must always
		// reach the blocklist, never evaporate into a metric.
		await suppressComplainerByAddress(ctx, e);
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
			// send is not ours. When the provider named the complainer, the address
			// goes on the blocklist under the same provenance rule as the redacted
			// branch above, and the complaint is stored for replay either way.
			const isSuppressed = await suppressComplainerByAddress(ctx, e);
			await recordUnresolvedFeedback(
				ctx,
				{ ...e, providerMessageId: e.providerMessageId },
				{ isSuppressed }
			);
		}
	}
	await observeYahooCflReport(ctx, e);
}

/**
 * Put a complainer's address on the blocklist when the complaint cannot be
 * attributed through a Send: it carries no Message-ID, or one that matches no
 * Send. Returns whether the address was suppressed (or already was).
 *
 * ASK WHETHER THE SOURCE TAGS ITS FEEDBACK, don't name the provider. This
 * used to read `e.providerType === 'ses' || e.deliveryDomain === 'production'`
 * — SES by name, for a property SES shares with every third-party ESP: nobody
 * annotates their webhook with our `deliveryDomain`, because that tag is
 * written on the way out of our own infrastructure and nothing else. So a
 * byte-identical redacted complaint from Mandrill, an SMTP relay's FBL or a
 * plugin ESP was DROPPED, and the complainer stayed mailable.
 *
 * Both directions are load-bearing. A tagged source must show `production`:
 * the tag's one writer stamps it only on an exactly-VERP-attributed report
 * and drops the effect list on `unknown` provenance, so it is the evidence
 * that this complaint is about real production mail rather than member-preview
 * mail or an unattributed guess. An untagged source has no tag to show, so
 * requiring one would suppress nothing it ever reports.
 *
 * A SOURCE WE CANNOT IDENTIFY is neither, and requires the tag. An event with
 * no `providerType` (or one naming a kind this deployment does not have)
 * carries no evidence about who observed it, and blocklisting an address on
 * an unattributable report is the one error here that is invisible and
 * permanent — the recipient simply stops receiving mail.
 *
 * The webhook signature was checked before dispatch, so the report is not
 * forged; the rule is about ATTRIBUTION — whether the complaint is about mail
 * this deployment sent — which matters just as much when a Message-ID is
 * present but resolves to nothing.
 */
async function suppressComplainerByAddress(
	ctx: ActionCtx,
	e: InboundEventOf<'email.complained'>
): Promise<boolean> {
	const source = isSendProviderKind(e.providerType) ? e.providerType : null;
	const needsProvenanceTag = source === null || tagsFeedbackProvenanceFor(source);
	if (!e.recipient || (needsProvenanceTag && e.deliveryDomain !== 'production')) return false;
	await ctx.runMutation(internal.blockedEmails.addFromEvent, {
		email: e.recipient,
		reason: 'complained',
	});
	return true;
}
