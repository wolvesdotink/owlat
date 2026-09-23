/**
 * Marketing dispatch gate (module) — the worker's last check before a
 * MARKETING envelope leaves: is the address suppressed, and may the contact
 * still receive marketing at all?
 *
 * Intake-time checks are not enough on their own. A campaign resolves its
 * audience once and may dispatch up to ~24h later (timezone path, rate-limited
 * queue); an automation Send sits in the transactional pool, and can be parked
 * by a deferral. A hard bounce, complaint or manual block (the blocklist), or a
 * global unsubscribe or contact deletion (`lib/marketingEligibility.ts`) landing
 * in that window must still stop the message.
 *
 * Which envelopes are marketing:
 *   - every `campaign` envelope. A seed-probe shadow copy is addressed to an
 *     operator-owned seed mailbox, not the contact, so only its address is
 *     checked.
 *   - a `transactional` envelope with `emailPurpose: 'marketing'` and a
 *     `sendId` — an automation email step. Real transactional mail (API sends,
 *     agent replies, previews) is out of scope: an unsubscribe must not block
 *     a receipt, and those kinds gate on the blocklist at intake under their
 *     own scope.
 *
 * Point reads only: one `blockedEmails.by_email` lookup and one contact get.
 */

import { v } from 'convex/values';
import { internalQuery, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { findBlockedByEmail } from '../blockedEmails/lookup';
import {
	loadContactMarketingIneligibility,
	type MarketingIneligibility,
} from '../lib/marketingEligibility';
import type { WorkerEnvelopeInput } from './workerEnvelope';

/** Why a marketing envelope may not be dispatched. */
type MarketingDispatchRefusal = 'blocklist' | MarketingIneligibility;

export const checkMarketingDispatch = internalQuery({
	args: {
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
	},
	handler: async (ctx, args): Promise<MarketingDispatchRefusal | null> => {
		if ((await findBlockedByEmail(ctx, args.email)) !== null) return 'blocklist';
		if (args.contactId === undefined) return null;
		return await loadContactMarketingIneligibility(ctx, args.contactId);
	},
});

/** The address and contact to gate, or `null` when the envelope is not marketing. */
function marketingRecipient(
	envelope: WorkerEnvelopeInput
): { email: string; contactId?: Id<'contacts'> } | null {
	if (envelope.kind === 'campaign') {
		const contactId =
			envelope.seedProbeRef === undefined ? envelope.contactInfo.contactId : undefined;
		return { email: envelope.to, ...(contactId !== undefined ? { contactId } : {}) };
	}
	if (envelope.emailPurpose === 'marketing' && envelope.sendId !== undefined) {
		return {
			email: envelope.to,
			...(envelope.contactId !== undefined ? { contactId: envelope.contactId } : {}),
		};
	}
	return null;
}

/**
 * The worker's `suppressed` outcome when a marketing envelope must not be
 * dispatched, else `null`. The worker RETURNS it (never throws) so the
 * workpool does not retry; the Send completion handler turns it into a
 * terminal non-delivery. A blocklist hit carries no `reason` — the shape the
 * arm had before contact eligibility joined it.
 */
export async function refuseMarketingDispatch(
	ctx: Pick<ActionCtx, 'runQuery'>,
	envelope: WorkerEnvelopeInput
): Promise<{ kind: 'suppressed'; reason?: MarketingIneligibility } | null> {
	const recipient = marketingRecipient(envelope);
	if (recipient === null) return null;
	const refusal = await ctx.runQuery(
		internal.delivery.marketingDispatchGate.checkMarketingDispatch,
		recipient
	);
	if (refusal === null) return null;
	return refusal === 'blocklist' ? { kind: 'suppressed' } : { kind: 'suppressed', reason: refusal };
}
