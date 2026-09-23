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
import { internalQuery } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { findBlockedByEmail } from '../blockedEmails/lookup';
import {
	loadContactMarketingIneligibility,
	type MarketingIneligibility,
} from '../lib/marketingEligibility';
import type { WorkerEnvelopeInput } from './workerEnvelope';

/** The worker's pre-dispatch refusal (see {@link checkMarketingDispatch}). */
export type MarketingDispatchRefusal = { kind: 'suppressed'; reason?: MarketingIneligibility };

/**
 * The worker's `suppressed` outcome when a marketing envelope must not be
 * dispatched, else `null`. A blocklist hit carries no `reason` — the shape the
 * arm had before contact eligibility joined it.
 */
export const checkMarketingDispatch = internalQuery({
	args: {
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
	},
	handler: async (ctx, args): Promise<MarketingDispatchRefusal | null> => {
		if ((await findBlockedByEmail(ctx, args.email)) !== null) return { kind: 'suppressed' };
		if (args.contactId === undefined) return null;
		const reason = await loadContactMarketingIneligibility(ctx, args.contactId);
		return reason === null ? null : { kind: 'suppressed', reason };
	},
});

/**
 * The address and contact the worker must pass to {@link checkMarketingDispatch}
 * before dispatching `envelope`, or `null` when the envelope is not marketing.
 */
export function marketingDispatchRecipient(
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
