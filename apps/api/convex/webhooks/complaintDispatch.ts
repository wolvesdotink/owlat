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
import {
	isSendNotFound,
	recordUnattributedComplaint,
	recordUnresolvedFeedback,
} from './unresolvedBounce';
import { observeYahooCflReport } from './yahooCflObservation';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { tagsFeedbackProvenanceFor } from '../lib/sendProviders/catalog';
import { isSendProviderKind } from '../lib/sendProviders/types';
import type { UnresolvedFeedbackSuppression } from '../lib/literalValidators';

/**
 * SUPPRESSION FIRST, bookkeeping second. A complaint that proves this
 * deployment sent the mail must always reach the blocklist, so both attribution
 * branches run to completion before the feedback-loop observation is even
 * attempted.
 *
 * ONE ATTRIBUTION RULE FOR EVERY COMPLAINT THAT NAMES NO SEND (#1194, #1227).
 * A complaint that resolves to a Send moves that Send, whose recipient is the
 * address to block. A complaint that names no Send, because its Message-ID was
 * redacted (RFC 5965 §3.2, e.g. Gmail) or matches nothing here, carries only an
 * address, and the address is blocked only when the event proves THIS
 * deployment sent the mail ({@link suppressAttributedComplainer}).
 *
 * WHY, AND WHAT IT COSTS. The webhook signature proves the PROVIDER sent the
 * report, not which deployment sent the mail. A provider account, webhook or
 * SNS topic shared by several deployments (staging and production, two teams;
 * Owlat runs one organization per deployment) delivers every tenant's feedback
 * to each of them, so blocking on it lets one deployment's complaint silently
 * and permanently stop mail to that address in another. The redacted branch
 * used to block for any source that does not tag its feedback (SES, Resend,
 * Mandrill, Emailit, plugin providers), which left the branch with the LEAST
 * evidence suppressing more readily than the unknown-id branch. It now applies
 * the same rule. The cost lands on single-deployment setups: an untagged
 * provider's redacted complaint is counted (`unresolvedFeedback`,
 * `suppression: 'unattributed'`, no address) instead of blocking. In practice
 * that is a plugin provider's address-only complaint or SES's fallback when
 * `mail.messageId` is missing: Resend, Mandrill and Emailit always key on their
 * own id, and the MTA tags its reports. A per-deployment marker the providers
 * echo back (SES message tags, `X-MC-Metadata`, Resend tags) would let both
 * branches block again; that is the long-term fix.
 */
export async function dispatchComplaint(
	ctx: ActionCtx,
	e: InboundEventOf<'email.complained'>
): Promise<void> {
	if (!e.providerMessageId) {
		// Recipient-only complaint: no Send to transition and no id to replay by.
		// An unattributed one is still counted, so it does not simply vanish.
		const suppression = await suppressAttributedComplainer(ctx, e);
		if (suppression === 'unattributed') await recordUnattributedComplaint(ctx, e);
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
			const suppression = await suppressAttributedComplainer(ctx, e);
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
 * Block the address a complaint names ONLY when the event proves this
 * deployment sent the mail it is about. Used for every complaint that names no
 * Send: a redacted Message-ID and one that matches nothing here alike.
 *
 * The one proof available today is the provenance tag our own infrastructure
 * writes: `deliveryDomain: 'production'` from a source that declares
 * `tagsFeedbackProvenance` (the MTA), stamped only on a report whose signed VERP
 * token decoded, i.e. on mail this deployment's key signed. SES, Resend and
 * Mandrill echo back no marker Owlat stamps per deployment (no message tag,
 * metadata or header the adapters could read), and neither do Emailit or the
 * plugin providers, so their complaints are recorded as `unattributed` and
 * never block an address. An unidentifiable source proves nothing either, even
 * with a production tag: the tag is only evidence from the source that writes
 * it. A member-preview or untagged MTA report is `unattributed` too.
 */
async function suppressAttributedComplainer(
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
